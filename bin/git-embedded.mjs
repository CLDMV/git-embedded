#!/usr/bin/env node

import slothlet from "@cldmv/slothlet";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import chalk from "chalk";
import { Command, Help } from "commander";
import { wisp, wispSync } from "@cldmv/wisp";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

// `showSectionPrefix: false` strips `##` from headers; marked-terminal hard-codes
// `* ` as the bullet point, so swap it back to `-` to match the source markdown.
marked.use(markedTerminal({ showSectionPrefix: false }));
const renderMarkdown = (md) => marked.parse(md).replace(/^(\s*)\* /gm, "$1- ");

if (typeof Command.prototype.examples !== "function") {
	Command.prototype.examples = function (arr) {
		if (arguments.length === 0) return this._exampleList || [];
		this._exampleList = Array.isArray(arr) ? arr : [];
		return this;
	};
}

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const apiDir = path.join(packageRoot, "src", "api");

const api = await slothlet({
	dir: apiDir,
	context: {
		fs,
		path,
		os,
		chalk,
		readline,
		spawn,
		spawnSync,
		fileURLToPath,
		pathToFileURL,
		commander: { Command, Help },
		wisp,
		wispSync,
		renderMarkdown,
		packageRoot
	}
});

const { CustomHelp, applyCustomHelpRecursive } = api.commander.customHelp.makeCustomHelp(Help, { chalk });

const program = new Command();
program.createHelp = () => new CustomHelp();
program
	.name("git-embedded")
	.description(
		"Manage embedded git repositories (anonymous gitlinks). Installs hooks that keep embedded children in sync without writing a .gitmodules entry."
	)
	.configureOutput({ writeErr: () => {} })
	.exitOverride();

registerCommandsFromApi(api, program);

program
	.command("help [cmd...]")
	.description("Show help for a command")
	.action((cmds) => {
		if (cmds && cmds.length) {
			let sub = program;
			for (const c of cmds) sub = sub.commands.find((x) => x.name() === c) || sub;
			sub.help();
		} else {
			program.help();
		}
	});

program.action(() => {
	program.outputHelp();
	process.exit(0);
});

applyCustomHelpRecursive(program);

process.on("uncaughtException", (error) => {
	console.error(chalk.red(`✗ unexpected error: ${error && error.message ? error.message : error}`));
	if (process.env.DEBUG) console.error(error);
	process.exit(1);
});

try {
	await program.parseAsync(process.argv);
} catch (err) {
	if (err && (err.code === "commander.helpDisplayed" || err.code === "commander.help" || err.code === "commander.version")) {
		process.exit(0);
	}
	if (err && typeof err.code === "string" && err.code.startsWith("commander.")) {
		let helpShown = false;
		if (err.command && typeof err.command.outputHelp === "function") {
			err.command.outputHelp();
			helpShown = true;
		} else if (process.argv[2]) {
			const sub = program.commands.find((cmd) => {
				if (cmd.name() === process.argv[2]) return true;
				const aliases = typeof cmd.aliases === "function" ? cmd.aliases() : cmd._aliases;
				return Array.isArray(aliases) && aliases.includes(process.argv[2]);
			});
			if (sub && typeof sub.outputHelp === "function") {
				sub.outputHelp();
				helpShown = true;
			}
		}
		if (!helpShown) program.outputHelp();
		console.error(chalk.red(`\n${(err.message || "").trim()}`));
		process.exit(typeof err.exitCode === "number" ? err.exitCode : 1);
	}
	throw err;
}

/**
 * Build commander subcommands from every leaf under `api.cli.*` that exposes
 * `{ spec, run }`. Third-party plugins can extend the CLI surface at runtime
 * via `api.slothlet.api.add("cli.myCommand", "/abs/path/to/leaf-folder")`
 * before this is called.
 */
function registerCommandsFromApi(rootApi, programInstance) {
	const cli = rootApi && rootApi.cli;
	if (!cli) return;
	for (const key of Object.keys(cli)) {
		const leaf = cli[key];
		if (!leaf || typeof leaf !== "object") continue;
		const spec = leaf.spec;
		const run = leaf.run;
		if (!spec || typeof run !== "function") continue;
		registerCommand(programInstance, spec, run);
	}
}

function registerCommand(programInstance, spec, run) {
	const commandName = spec.command;
	if (!commandName) return;
	const cmd = programInstance.command(commandName);
	const aliases = Array.isArray(spec.aliases) ? spec.aliases : asArray(spec.aliases);
	if (aliases.length) cmd.aliases(aliases);
	if (spec.description) cmd.description(spec.description);
	const args = asArray(spec.args);
	for (const rawEntry of args) {
		const entry = asArray(rawEntry);
		const [a, desc] = entry;
		if (a) cmd.argument(a, desc || "");
	}
	const options = asArray(spec.options);
	for (const rawEntry of options) {
		const entry = asArray(rawEntry);
		const [flags, desc] = entry;
		if (flags) cmd.option(flags, desc || "");
	}
	const examples = Array.isArray(spec.examples) ? spec.examples : asArray(spec.examples);
	if (examples.length) cmd.examples(examples);
	cmd.action(async (...actionArgs) => {
		const last = actionArgs[actionArgs.length - 1];
		const isCmd = last && typeof last === "object" && typeof last.opts === "function";
		const trimmed = isCmd ? actionArgs.slice(0, -1) : actionArgs;
		await run(...trimmed);
	});
}

/**
 * Slothlet wraps spec arrays as Function-shaped proxies — `.length` returns
 * `Function.prototype.length` (0), but numeric-keyed elements are intact. Walk
 * indices until one is missing.
 */
function asArray(maybe) {
	if (Array.isArray(maybe)) return maybe;
	if (maybe == null || typeof maybe !== "object") return [];
	const out = [];
	let i = 0;
	while (i in maybe) {
		out.push(maybe[i]);
		i++;
	}
	return out;
}
