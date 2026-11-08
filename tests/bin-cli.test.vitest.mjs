/**
 *
 *	@Project: @cldmv/git-embedded
 *	@Filename: /tests/bin-cli.test.vitest.mjs
 *	@Date: 2026-11-07T22:31:21-08:00 (1794119481)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-07T22:33:54-08:00 (1794119634)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * In-process coverage of src/bin/git-embedded.mjs. The entry runs at import
 * time, so each case sets process.argv, stubs process.exit, and imports a
 * fresh module instance via a unique query string.
 */

class ExitSignal extends Error {
	constructor(code) {
		super(`exit ${code}`);
		this.code = code;
	}
}

const entry = new URL("../src/bin/git-embedded.mjs", import.meta.url).href;
let counter = 0;
let out;
let err;
let originalArgv;
let originalListeners;

// eslint-disable-next-line no-control-regex
const strip = (s) => s.replace(/\u001b\[[0-9;]*m/g, "");

/**
 * Run the CLI with the given args; resolves to { code, stdout, stderr } where
 * code is the process.exit code, or null if the entry finished without exiting.
 */
async function runCli(args) {
	process.argv = ["node", "git-embedded", ...args];
	let code = null;
	try {
		await import(`${entry}?case=${++counter}`);
	} catch (e) {
		if (e instanceof ExitSignal) code = e.code;
		else throw e;
	}
	return { code, stdout: strip(out.join("")), stderr: strip(err.join("")) };
}

function addedListeners() {
	return process.listeners("uncaughtException").filter((l) => !originalListeners.includes(l));
}

beforeEach(() => {
	out = [];
	err = [];
	originalArgv = process.argv;
	originalListeners = process.listeners("uncaughtException");
	vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new ExitSignal(code);
	});
	vi.spyOn(process.stdout, "write").mockImplementation((s) => {
		out.push(String(s));
		return true;
	});
	vi.spyOn(console, "log").mockImplementation((...a) => out.push(a.join(" ") + "\n"));
	vi.spyOn(console, "error").mockImplementation((...a) => err.push(a.join(" ") + "\n"));
});

afterEach(() => {
	for (const l of addedListeners()) process.removeListener("uncaughtException", l);
	process.argv = originalArgv;
	vi.restoreAllMocks();
});

describe("git-embedded bin entry", () => {
	it("shows root help and exits 0 with no arguments", async () => {
		const res = await runCli([]);
		expect(res.code).toBe(0);
		expect(res.stdout).toContain("git-embedded");
		expect(res.stdout).toContain("version");
	});

	it("shows root help for `help` with no command name", async () => {
		const res = await runCli(["help"]);
		expect(res.code).toBe(0);
		expect(res.stdout).toContain("Commands");
	});

	it("shows command help for `help <cmd>`", async () => {
		const res = await runCli(["help", "version"]);
		expect(res.code).toBe(0);
		expect(res.stdout).toContain("Print git-embedded, node, and platform versions");
	});

	it("falls back to the parent when `help <unknown>` names no command", async () => {
		const res = await runCli(["help", "nope"]);
		expect(res.code).toBe(0);
		expect(res.stdout).toContain("Commands");
	});

	it.each([["--help"], ["-h"]])("exits 0 with help for %s", async (flag) => {
		const res = await runCli([flag]);
		expect(res.code).toBe(0);
		expect(res.stdout).toContain("Commands");
	});

	it("runs a known command (`version`) and prints its output", async () => {
		const res = await runCli(["version"]);
		expect(res.code).toBeNull();
		expect(res.stdout).toContain("@cldmv/git-embedded");
		expect(res.stdout).toContain(`node ${process.version.replace(/^v/, "")}`);
		expect(res.stdout).toContain(`platform ${process.platform}`);
		expect(addedListeners()).toHaveLength(1);
	});

	it.each([["-V"], ["--version"]])("looks up the command by its %s alias when commander rejects the flag", async (flag) => {
		const res = await runCli([flag]);
		expect(res.code).toBe(1);
		expect(res.stdout).toContain("Usage: git-embedded version");
		expect(res.stderr).toContain("error:");
	});

	it("shows root help and the error for an unknown command", async () => {
		const res = await runCli(["bogus-cmd"]);
		expect(res.code).toBe(1);
		expect(res.stdout).toContain("Commands");
		expect(res.stderr).toContain("too many arguments");
	});

	it("shows the subcommand's help for an unknown option", async () => {
		const res = await runCli(["version", "--bogus"]);
		expect(res.code).toBe(1);
		expect(res.stdout).toContain("Print git-embedded, node, and platform versions");
		expect(res.stderr).toContain("unknown option");
	});

	it("reports a missing option argument with the command's help", async () => {
		const res = await runCli(["export", "-o"]);
		expect(res.code).toBe(1);
		expect(res.stderr).toContain("argument missing");
	});

	it("rethrows non-commander errors from a command's run", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {
			throw new Error("boom from run");
		});
		process.argv = ["node", "git-embedded", "version"];
		await expect(import(`${entry}?case=${++counter}`)).rejects.toThrow("boom from run");
		spy.mockRestore();
	});

	it("renders a markdown message through a command that reports one (`doctor` in a temp git repo)", async () => {
		const root = path.join(process.cwd(), "tmp", "agents", "cli-tests");
		fs.mkdirSync(root, { recursive: true });
		const repo = fs.mkdtempSync(path.join(root, "doctor-"));
		try {
			expect(spawnSync("git", ["init", "-q"], { cwd: repo }).status).toBe(0);
			vi.spyOn(process, "cwd").mockReturnValue(repo);
			const res = await runCli(["doctor"]);
			expect(res.code).toBeNull();
			expect(res.stdout.length).toBeGreaterThan(0);
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	it("registers an uncaughtException handler that reports and exits 1", async () => {
		await runCli(["version"]);
		const [handler] = addedListeners();
		expect(handler).toBeTypeOf("function");

		expect(() => handler(new Error("kaboom"))).toThrow(ExitSignal);
		expect(strip(err.join(""))).toContain("unexpected error: kaboom");
		expect(process.exit).toHaveBeenLastCalledWith(1);

		err.length = 0;
		expect(() => handler("plain string")).toThrow(ExitSignal);
		expect(strip(err.join(""))).toContain("unexpected error: plain string");

		err.length = 0;
		vi.stubEnv("DEBUG", "1");
		const e = new Error("dbg");
		expect(() => handler(e)).toThrow(ExitSignal);
		expect(console.error).toHaveBeenLastCalledWith(e);
		vi.unstubAllEnvs();
	});

	it("uses the command attached to a commander error for help", async () => {
		const { CommanderError, Command } = await import("commander");
		const sub = new Command("fake");
		sub.description("fake command help");
		const failure = new CommanderError(2, "commander.custom", "custom failure");
		failure.command = sub;
		vi.spyOn(console, "log").mockImplementation(() => {
			throw failure;
		});
		const outputHelp = vi.spyOn(sub, "outputHelp").mockImplementation(() => {
			out.push("fake help\n");
		});
		const res = await runCli(["version"]);
		expect(outputHelp).toHaveBeenCalled();
		expect(res.code).toBe(2);
		expect(res.stdout).toContain("fake help");
		expect(res.stderr).toContain("custom failure");
	});

	it("falls back to a numeric exit code of 1 and root help when the error has no usable command", async () => {
		const { CommanderError } = await import("commander");
		const failure = new CommanderError(undefined, "commander.custom", "");
		failure.exitCode = "x";
		vi.spyOn(console, "log").mockImplementation(() => {
			throw failure;
		});
		// argv[2] is "export", whose alias search finds nothing for "nothing" -> use a name matching no command
		const res = await runCli(["version"]);
		expect(res.code).toBe(1);
		expect(res.stdout).toContain("version");
	});

	it("shows root help when an empty-string argument is rejected", async () => {
		const res = await runCli([""]);
		expect(res.code).toBe(1);
		expect(res.stdout).toContain("Commands");
		expect(res.stderr).toContain("too many arguments");
	});

	it("exposes the examples() accessor shim on commander's Command", async () => {
		const { Command } = await import("commander");
		await runCli(["version"]);
		const cmd = new Command("x");
		expect(cmd.examples()).toEqual([]);
		expect(cmd.examples(["$ x"])).toBe(cmd);
		expect(cmd.examples()).toEqual(["$ x"]);
		cmd.examples("not an array");
		expect(cmd.examples()).toEqual([]);
	});

	it("shows root help when the unknown option precedes any command name", async () => {
		const res = await runCli(["--bogus"]);
		expect(res.code).toBe(1);
		expect(res.stdout).toContain("Commands");
		expect(res.stderr).toContain("unknown option");
	});
});

describe("git-embedded bin entry with a synthetic api", () => {
	afterEach(() => {
		vi.doUnmock("@cldmv/slothlet");
		vi.resetModules();
	});

	/** Re-import the entry with slothlet returning the real api but with `cli` replaced. */
	async function runWithCli(cli, args, { dropCli = false } = {}) {
		vi.resetModules();
		const actual = await vi.importActual("@cldmv/slothlet");
		vi.doMock("@cldmv/slothlet", () => ({
			default: async (opts) => {
				const real = await actual.default(opts);
				return dropCli ? { commander: real.commander } : { cli, commander: real.commander };
			}
		}));
		return runCli(args);
	}

	it("registers nothing when the api has no cli namespace", async () => {
		const res = await runWithCli(null, ["anything"], { dropCli: true });
		expect(res.code).toBe(1);
		expect(res.stderr).toContain("too many arguments");
	});

	it("skips leaves that are not objects, lack a spec/run, or lack a command name", async () => {
		const ran = vi.fn();
		const res = await runWithCli(
			{
				a: null,
				b: "text",
				c: { spec: { command: "c" } },
				d: { run: ran },
				e: { spec: { description: "no command" }, run: ran }
			},
			["c"]
		);
		expect(res.code).toBe(1);
		expect(ran).not.toHaveBeenCalled();
	});

	it("builds args, options, aliases and examples from array specs and strips the command from run args", async () => {
		const run = vi.fn();
		const res = await runWithCli(
			{
				one: {
					spec: {
						command: "one",
						aliases: ["uno"],
						description: "first",
						args: [["<name>", "the name"], ["[extra]"], [""]],
						options: [["-f, --force", "force it"], ["--quiet"], [""]],
						examples: ["$ git-embedded one x"]
					},
					run
				}
			},
			["uno", "bob", "--force"]
		);
		expect(res.code).toBeNull();
		expect(run).toHaveBeenCalledTimes(1);
		expect(run.mock.calls[0][0]).toBe("bob");
		expect(run.mock.calls[0][1]).toBeUndefined();
		expect(run.mock.calls[0][2]).toEqual({ force: true });
		expect(run.mock.calls[0]).toHaveLength(3);
	});

	it("walks array-like (non-array object) specs by numeric index", async () => {
		// Plain objects with numeric keys; asArray only walks `typeof === "object"` values.
		const proxyArray = (...items) => Object.assign({}, items);
		const run = vi.fn();
		const res = await runWithCli(
			{
				two: {
					spec: {
						command: "two",
						aliases: proxyArray("dos"),
						description: "second",
						args: proxyArray(proxyArray("<who>", "target")),
						options: proxyArray(proxyArray("--loud", "be loud")),
						examples: proxyArray("$ git-embedded two me")
					},
					run
				}
			},
			["dos", "me", "--loud"]
		);
		expect(res.code).toBeNull();
		expect(run.mock.calls[0][0]).toBe("me");
		const help = await runWithCli(
			{ two: { spec: { command: "two", aliases: proxyArray("dos"), examples: proxyArray("$ git-embedded two me") }, run } },
			["two", "--help"]
		);
		expect(help.stdout).toContain("dos");
		expect(help.stdout).toContain("$ git-embedded two me");
	});

	it("treats non-array, non-object spec fields as empty and passes plain run args through", async () => {
		const run = vi.fn();
		const res = await runWithCli(
			{ three: { spec: { command: "three", aliases: "tres", args: 5, options: null, examples: undefined }, run } },
			["three"]
		);
		expect(res.code).toBeNull();
		expect(run).toHaveBeenCalledTimes(1);
	});
});
