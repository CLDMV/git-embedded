/**
 * Build a `Help` subclass that renders colorized, multi-line help with the
 * look the rest of the CLDMV CLIs use. The bin entry passes commander's
 * statically imported `Help` class in once.
 *
 * `deps.chalk` is also passed by the bin: commander invokes the help methods
 * outside any slothlet-tracked call, so the slothlet `context` proxy isn't
 * live in those frames. Closing over the chalk dep keeps the help renderer
 * standalone — it doesn't need the runtime to be active.
 *
 * @param {typeof import("commander").Help} HelpClass
 * @param {{ chalk: import("chalk").ChalkInstance }} deps
 * @returns {{ CustomHelp: typeof import("commander").Help, applyCustomHelpRecursive: Function }}
 */
export function makeCustomHelp(HelpClass, deps) {
	const chalk = deps && deps.chalk;
	if (!chalk) throw new Error("makeCustomHelp: deps.chalk is required");
	class CustomHelp extends HelpClass {
		static ensureHelpOption(cmd) {
			if (typeof cmd.helpOption === "function" && !cmd.options.some((opt) => opt.long === "--help")) {
				cmd.helpOption("-h, --help", "Show help for this command");
			}
			if (cmd.commands && cmd.commands.length) {
				for (const sub of cmd.commands) CustomHelp.ensureHelpOption(sub);
			}
		}

		constructor(opts = {}) {
			super();
			this.colorMode = typeof opts.colorMode === "string" ? opts.colorMode : "auto";
			this.initColorMode();
		}

		formatHelp(cmd, helper) {
			const color = (fn, str) => (this.colorMode === "never" ? str : fn(str));

			const output = [];
			const fullChain = getFullCommandChain(cmd);
			const usageArgList = helper.visibleArguments(cmd);
			const usageArgStr = usageArgList
				.map((a) => {
					const argStr = a.required ? `<${a.name()}>` : `[${a.name()}]`;
					const colorFn = a.required ? chalk.magenta : chalk.yellow;
					return color(colorFn, argStr);
				})
				.join(" ");
			const usageOptionList = helper.visibleOptions(cmd).filter((o) => o.long !== "--help");
			let usageLine = fullChain;
			if (usageArgStr) usageLine += ` ${usageArgStr}`;
			if (usageOptionList.length) usageLine += " [options]";
			output.push(color(chalk.bold, "Usage:") + ` ${usageLine}`);
			output.push("");

			if (cmd.description()) {
				output.push(color(chalk.bold, "Description:"));
				output.push(cmd.description());
				output.push("");
			}

			if (cmd._aliases && Array.isArray(cmd._aliases) && cmd._aliases.length > 0 && cmd.name() !== "help") {
				output.push(color(chalk.bold, "Aliases:"));
				for (const alias of cmd._aliases) output.push(`  ${color(chalk.yellow, alias)}`);
				output.push("");
			}

			const commandList = helper.visibleCommands(cmd);
			if (commandList.length) {
				const isTopLevel = !cmd.parent;
				output.push(color(chalk.bold, isTopLevel ? "Commands:" : "Sub Commands:"));
				printCommands(commandList, 1, output, color, helper);
			}

			const optionList = helper.visibleOptions(cmd);
			if (optionList.length) {
				output.push(color(chalk.bold, "Options:"));
				const width = optionList.reduce((max, o) => Math.max(max, helper.optionTerm(o).length), 0);
				for (const o of optionList) {
					const term = helper.optionTerm(o).padEnd(width);
					output.push(`  ${color(chalk.green, term)}  ${o.description}`);
				}
				output.push("");
			}

			const argList = helper.visibleArguments(cmd);
			if (argList.length) {
				output.push(color(chalk.bold, "Arguments:"));
				for (const a of argList) {
					const argStr = a.required ? `<${a.name()}>` : `[${a.name()}]`;
					const argColor = a.required ? chalk.magenta : chalk.yellow;
					const desc = a.description ? `  ${a.description}` : "";
					output.push(`  ${color(argColor, argStr)}${desc}`);
				}
				output.push("");
			}

			const examples = collectExamples(cmd);
			if (examples.length) {
				output.push(color(chalk.bold, "Examples:"));
				const argPattern = /(<([\w|-]+)>)|(\[([\w|-]+)\])/g;
				for (const ex of examples) {
					const colored = ex.replace(argPattern, (match, p1, p2, p3, p4) => {
						if (p2) return color(chalk.magenta, match);
						/* v8 ignore else -- defensive: argPattern's two alternatives each
						   require 1+ chars in their capture group, so a successful match
						   always sets p2 or p4; the else has no reachable real input. */
						if (p4) return color(chalk.yellow, match);
						else return match;
					});
					output.push(`  ${colored}`);
				}
				output.push("");
			}

			while (output.length > 0 && output[output.length - 1].trim() === "") output.pop();
			output.push(color(chalk.gray, "\nFor more information, use a command with help, --help, or -h."));
			output.push("");
			return output.join("\n");
		}

		setColorMode(mode) {
			this.colorMode = mode;
			if (mode === "always") chalk.level = 3;
			else if (mode === "never") chalk.level = 0;
		}

		initColorMode() {
			if (process.env.NO_COLOR) this.setColorMode("never");
			else if (process.env.FORCE_COLOR) this.setColorMode("always");
		}
	}

	function applyCustomHelpRecursive(cmd) {
		cmd.createHelp = () => new CustomHelp();
		if (typeof cmd.showHelpAfterError === "function") cmd.showHelpAfterError(true);
		CustomHelp.ensureHelpOption(cmd);
		if (cmd.commands && cmd.commands.length) {
			for (const sub of cmd.commands) applyCustomHelpRecursive(sub);
		}
	}

	function printCommands(commands, indent, output, color, helper) {
		for (const c of commands) {
			let term = c.name();
			if (c.options && c.options.some((opt) => opt.long !== "--help")) term += " [options]";
			if (c._args && c._args.length) {
				term +=
					" " +
					c._args
						.map((a) => {
							let name = a.name();
							if (a.variadic) name += "...";
							const argStr = a.required ? `<${name}>` : `[${name}]`;
							const colorFn = a.required ? chalk.magenta : chalk.yellow;
							return color(colorFn, argStr);
						})
						.join(" ");
			}
			let aliases = [];
			if (Array.isArray(c._aliases)) aliases = c._aliases.filter((a) => a !== c.name());
			else if (typeof c._aliases === "string" && c._aliases !== c.name()) aliases = [c._aliases];
			const desc = (helper.commandDescription ? helper.commandDescription(c) : c.description()) || "";

			const pad = "  ".repeat(indent);
			const cmdColor = indent === 1 ? chalk.cyan : chalk.blueBright;
			output.push(`${pad}${color(cmdColor, term)}`);
			if (aliases.length) {
				wrapTextWithHangingIndent(aliases.join(", "), indent + 1, "Aliases", (s) => color(chalk.yellow.italic, s)).forEach(
					(l) => output.push(l)
				);
			}
			if (desc) {
				wrapTextWithHangingIndent(desc, indent + 1, "Description", (s) => color(chalk.gray.italic, s)).forEach((l) =>
					output.push(l)
				);
			}
			output.push("");

			if (c.commands && c.commands.length) {
				printCommands(helper.visibleCommands(c), indent + 1, output, color, helper);
			}
		}
	}

	return { CustomHelp, applyCustomHelpRecursive };
}

function getFullCommandChain(cmd) {
	const names = [];
	let current = cmd;
	while (current) {
		if (current.name && typeof current.name === "function") {
			const n = current.name();
			if (n) names.unshift(n);
		}
		current = current.parent;
	}
	return names.join(" ");
}

function wrapTextWithHangingIndent(text, indent, label, labelColor, width) {
	const pad = "  ".repeat(indent);
	const prefix = "- ";
	/* v8 ignore next -- defensive: both call sites (Aliases/Description below)
	   always pass a non-empty literal label, and this private helper has no
	   other caller, so the empty-label fallback has no reachable real input. */
	const labelStr = label ? label + ": " : "";
	const hangingPad = pad + " ".repeat(prefix.length + labelStr.length);
	const maxWidth = (width || process.stdout.columns || 80) - (pad.length + prefix.length + labelStr.length);
	const words = text.split(/\s+/);
	const lines = [];
	let line = "";
	for (const word of words) {
		if ((line + word).length > maxWidth) {
			lines.push(line.trim());
			line = word + " ";
		} else {
			line += word + " ";
		}
	}
	if (line.trim()) lines.push(line.trim());
	return lines.map((l, i) => (i === 0 ? pad + prefix + labelColor(labelStr) + l : hangingPad + l));
}

function collectExamples(cmd) {
	if (!cmd.parent) {
		const all = [];
		walk(cmd, all);
		const dedup = Array.from(new Set(all));
		for (let i = dedup.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[dedup[i], dedup[j]] = [dedup[j], dedup[i]];
		}
		return dedup.slice(0, 5);
	}
	const own = cmd._exampleList;
	const out = Array.isArray(own) ? own.slice() : [];
	if (cmd.commands && cmd.commands.length) {
		for (const sub of cmd.commands) {
			const subName = sub.name();
			const parentChain = getFullCommandChain(cmd);
			let ex = `$ ${parentChain} ${subName}`;
			const subArgs = (sub._args || []).map((a) => (a.required ? `<${a.name()}>` : `[${a.name()}]`)).join(" ");
			if (subArgs) ex += ` ${subArgs}`;
			if (!out.some((e) => e.includes(subName))) out.push(ex);
		}
	}
	return out;
}

function walk(cmd, into) {
	if (Array.isArray(cmd._exampleList)) for (const e of cmd._exampleList) into.push(e);
	if (cmd.commands) for (const sub of cmd.commands) walk(sub, into);
}

export default { makeCustomHelp };
