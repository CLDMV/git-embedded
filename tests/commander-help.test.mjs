import { afterEach, beforeEach, describe, expect, it } from "vitest";
import chalk from "chalk";
import { Command, Help } from "commander";
import { makeCustomHelp } from "../src/api/commander/custom-help.mjs";
import customHelpDefault from "../src/api/commander/custom-help.mjs";

// This module is pure CLI-help formatting — it never shells out to git, so no
// temp git fixtures are needed. Every test builds a real commander `Command`
// tree and renders it through the CustomHelp the bin uses, asserting on the
// produced help text. The factory receives the real `chalk` singleton (as the
// bin does); tests that flip color modes restore `chalk.level` afterwards.

const ESC = String.fromCharCode(27); // color codes start with the ANSI escape
const hasAnsi = (s) => s.includes(ESC);

/** Fresh factory per call — cheap, and avoids sharing CustomHelp state. */
function build() {
	return makeCustomHelp(Help, { chalk });
}

/** A CustomHelp locked to "never" so rendered text is ANSI-free and easy to assert. */
function plainHelp() {
	return new (build().CustomHelp)({ colorMode: "never" });
}

let savedEnv;
let savedChalkLevel;
let savedColumns;

beforeEach(() => {
	// Baseline the color inputs the module reads so a test starts from "auto":
	// initColorMode() consults NO_COLOR / FORCE_COLOR in the constructor.
	savedEnv = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR };
	savedChalkLevel = chalk.level;
	savedColumns = process.stdout.columns;
	delete process.env.NO_COLOR;
	delete process.env.FORCE_COLOR;
});

afterEach(() => {
	if (savedEnv.NO_COLOR === undefined) delete process.env.NO_COLOR;
	else process.env.NO_COLOR = savedEnv.NO_COLOR;
	if (savedEnv.FORCE_COLOR === undefined) delete process.env.FORCE_COLOR;
	else process.env.FORCE_COLOR = savedEnv.FORCE_COLOR;
	chalk.level = savedChalkLevel;
	try {
		process.stdout.columns = savedColumns;
	} catch {
		// non-tty stdout may reject the assignment on some platforms
	}
});

describe("makeCustomHelp (factory guardrails)", () => {
	it("throws when chalk is not supplied", () => {
		expect(() => makeCustomHelp(Help)).toThrow(/deps\.chalk is required/);
		expect(() => makeCustomHelp(Help, {})).toThrow(/chalk/);
		expect(() => makeCustomHelp(Help, { chalk: null })).toThrow(/chalk/);
	});

	it("returns a CustomHelp class and applyCustomHelpRecursive when chalk is supplied", () => {
		const built = makeCustomHelp(Help, { chalk });
		expect(typeof built.CustomHelp).toBe("function");
		expect(built.CustomHelp.prototype).toBeInstanceOf(Help);
		expect(typeof built.applyCustomHelpRecursive).toBe("function");
	});

	it("exposes makeCustomHelp on the default export", () => {
		expect(typeof customHelpDefault.makeCustomHelp).toBe("function");
		expect(customHelpDefault.makeCustomHelp).toBe(makeCustomHelp);
	});
});

describe("CustomHelp constructor + color mode", () => {
	it("defaults colorMode to 'auto' when no env and no opts", () => {
		const { CustomHelp } = build();
		expect(new CustomHelp().colorMode).toBe("auto");
	});

	it("honors an explicit string colorMode and ignores a non-string one", () => {
		const { CustomHelp } = build();
		expect(new CustomHelp({ colorMode: "never" }).colorMode).toBe("never");
		expect(new CustomHelp({ colorMode: 123 }).colorMode).toBe("auto");
	});

	it("initColorMode: NO_COLOR forces 'never' and drops chalk.level to 0", () => {
		process.env.NO_COLOR = "1";
		const { CustomHelp } = build();
		const help = new CustomHelp();
		expect(help.colorMode).toBe("never");
		expect(chalk.level).toBe(0);
	});

	it("initColorMode: FORCE_COLOR forces 'always' and raises chalk.level to 3", () => {
		process.env.FORCE_COLOR = "1";
		const { CustomHelp } = build();
		const help = new CustomHelp();
		expect(help.colorMode).toBe("always");
		expect(chalk.level).toBe(3);
	});

	it("setColorMode toggles chalk.level for 'always'/'never' and leaves it for 'auto'", () => {
		const { CustomHelp } = build();
		const help = new CustomHelp({ colorMode: "auto" });

		help.setColorMode("always");
		expect(help.colorMode).toBe("always");
		expect(chalk.level).toBe(3);

		help.setColorMode("never");
		expect(help.colorMode).toBe("never");
		expect(chalk.level).toBe(0);

		// "auto" updates the mode but touches neither chalk branch.
		help.setColorMode("auto");
		expect(help.colorMode).toBe("auto");
		expect(chalk.level).toBe(0);
	});
});

describe("CustomHelp.ensureHelpOption (static)", () => {
	it("adds the -h/--help option when the command has none", () => {
		const { CustomHelp } = build();
		const calls = [];
		const cmd = { helpOption: (...a) => calls.push(a), options: [], commands: [] };
		CustomHelp.ensureHelpOption(cmd);
		expect(calls).toHaveLength(1);
		expect(calls[0][0]).toBe("-h, --help");
		expect(calls[0][1]).toBe("Show help for this command");
	});

	it("skips adding help when a --help option already exists", () => {
		const { CustomHelp } = build();
		let called = 0;
		const cmd = {
			helpOption: () => {
				called++;
			},
			options: [{ long: "--help" }],
			commands: []
		};
		CustomHelp.ensureHelpOption(cmd);
		expect(called).toBe(0);
	});

	it("recurses into subcommands", () => {
		const { CustomHelp } = build();
		let childCalled = 0;
		const child = {
			helpOption: () => {
				childCalled++;
			},
			options: [],
			commands: []
		};
		const root = { helpOption: () => {}, options: [], commands: [child] };
		CustomHelp.ensureHelpOption(root);
		expect(childCalled).toBe(1);
	});

	it("tolerates a command with no helpOption function", () => {
		const { CustomHelp } = build();
		const cmd = { options: [], commands: [] };
		expect(() => CustomHelp.ensureHelpOption(cmd)).not.toThrow();
	});
});

describe("formatHelp — usage line", () => {
	it("renders required args as <name> and optional as [name], with a full command chain", () => {
		const help = plainHelp();
		const program = new Command("git-embedded");
		const restore = program.command("restore");
		const inner = restore.command("inner");
		inner.argument("<name>", "the child").argument("[extra]");
		const usage = help.formatHelp(inner, help).split("\n")[0];
		expect(usage).toContain("Usage: git-embedded restore inner");
		expect(usage).toContain("<name>");
		expect(usage).toContain("[extra]");
	});

	it("appends [options] only when a non-help option exists", () => {
		const help = plainHelp();

		const bare = new Command("bare");
		const bareUsage = help.formatHelp(bare, help).split("\n")[0];
		expect(bareUsage).toBe("Usage: bare");
		expect(bareUsage).not.toContain("[options]");

		const withOpt = new Command("withopt");
		withOpt.option("--verbose", "be loud");
		const withUsage = help.formatHelp(withOpt, help).split("\n")[0];
		expect(withUsage).toContain("[options]");
	});
});

describe("formatHelp — sections", () => {
	it("renders the Description section when present and omits it otherwise", () => {
		const help = plainHelp();

		const described = new Command("described");
		described.description("Does a described thing.");
		const out = help.formatHelp(described, help);
		expect(out).toContain("Description:");
		expect(out).toContain("Does a described thing.");

		const bare = new Command("bare");
		expect(help.formatHelp(bare, help)).not.toContain("Description:");
	});

	it("renders the command's own Aliases section, skipping it for the 'help' command", () => {
		const help = plainHelp();

		const build = new Command("build");
		build._aliases = ["b", "bld"];
		const buildOut = help.formatHelp(build, help);
		const lines = buildOut.split("\n");
		expect(buildOut).toContain("Aliases:");
		expect(lines).toContain("  b");
		expect(lines).toContain("  bld");

		// A command literally named "help" suppresses its Aliases section.
		const helpCmd = new Command("help");
		helpCmd._aliases = ["h"];
		expect(help.formatHelp(helpCmd, help)).not.toContain("Aliases:");

		// No aliases at all → no section.
		expect(help.formatHelp(new Command("plain"), help)).not.toContain("Aliases:");
	});

	it("uses 'Commands:' at the top level and 'Sub Commands:' for a nested command", () => {
		const help = plainHelp();
		const program = new Command("git-embedded");
		const restore = program.command("restore");
		restore.command("inner");

		const top = help.formatHelp(program, help);
		expect(top).toContain("Commands:");
		expect(top).not.toContain("Sub Commands:");

		const nested = help.formatHelp(restore, help);
		expect(nested).toContain("Sub Commands:");
	});

	it("aligns the Options description column via padEnd", () => {
		const help = plainHelp();
		const cmd = new Command("prog");
		cmd.option("-a, --alpha", "first option");
		cmd.option("--beta-long-flag <value>", "second option");
		const out = help.formatHelp(cmd, help);
		expect(out).toContain("Options:");
		const lines = out.split("\n");
		const alpha = lines.find((l) => l.includes("--alpha"));
		const beta = lines.find((l) => l.includes("--beta-long-flag"));
		expect(alpha).toBeTruthy();
		expect(beta).toBeTruthy();
		// The short term is padded so both descriptions start at the same column.
		expect(alpha.indexOf("first option")).toBe(beta.indexOf("second option"));
	});

	it("renders the Arguments section with and without per-argument descriptions", () => {
		const help = plainHelp();
		const cmd = new Command("args");
		cmd.argument("<req>", "required one");
		cmd.argument("[opt]"); // no description
		const out = help.formatHelp(cmd, help);
		expect(out).toContain("Arguments:");
		const lines = out.split("\n").map((l) => l.trim());
		expect(lines).toContain("<req>  required one");
		expect(lines).toContain("[opt]");
	});

	it("renders the Examples section with the example text intact", () => {
		const help = plainHelp();
		const cmd = new Command("ex");
		cmd._exampleList = ["$ ex --flag <arg>"];
		const out = help.formatHelp(cmd, help);
		expect(out).toContain("Examples:");
		expect(out).toContain("$ ex --flag <arg>");
	});

	it("always ends with the trailing 'For more information' footer", () => {
		const help = plainHelp();
		const out = help.formatHelp(new Command("bare"), help);
		expect(out.trimEnd().endsWith("For more information, use a command with help, --help, or -h.")).toBe(true);
	});
});

describe("formatHelp — color modes", () => {
	it("colorMode 'never' emits no ANSI and leaves arg markers as plain text", () => {
		const help = plainHelp();
		const cmd = new Command("prog");
		cmd.argument("<req>", "r").argument("[opt]", "o");
		cmd._exampleList = ["$ prog <req> [opt]"];
		const out = help.formatHelp(cmd, help);
		expect(hasAnsi(out)).toBe(false);
		expect(out).toContain("<req>");
		expect(out).toContain("[opt]");
	});

	it("colorMode 'always' emits ANSI color codes and a longer string than 'never'", () => {
		const { CustomHelp } = build();
		const cmd = new Command("prog");
		cmd.argument("<req>", "r").argument("[opt]", "o");
		cmd._exampleList = ["$ prog <req> [opt]"];

		const never = new CustomHelp({ colorMode: "never" });
		const plain = never.formatHelp(cmd, never);

		const always = new CustomHelp({ colorMode: "always" });
		always.setColorMode("always"); // raise chalk.level so codes are actually emitted
		const colored = always.formatHelp(cmd, always);

		expect(hasAnsi(colored)).toBe(true);
		expect(hasAnsi(plain)).toBe(false);
		expect(colored.length).toBeGreaterThan(plain.length);
	});
});

describe("printCommands (via a parent's help)", () => {
	it("renders subcommand terms with [options], args, variadic markers, and deeper nesting", () => {
		const help = plainHelp();
		const program = new Command("git-embedded");
		const restore = program.command("restore").option("--dry-run", "plan only");
		const inner = restore.command("inner");
		inner.option("--flag", "f").argument("<required>", "r").argument("[optional...]", "o");
		program.command("plain"); // no options → term must omit [options]

		const out = help.formatHelp(program, help);
		expect(out).toMatch(/restore \[options\]/);
		expect(out).toContain("inner [options] <required> [optional...]");

		const lines = out.split("\n");
		const lead = (s) => s.match(/^\s*/)[0].length;
		const restoreLine = lines.find((l) => l.includes("restore [options]"));
		const innerLine = lines.find((l) => l.includes("inner [options]"));
		expect(lead(innerLine)).toBeGreaterThan(lead(restoreLine));

		const plainLine = lines.find((l) => l.trim() === "plain");
		expect(plainLine).toBeTruthy();
		expect(plainLine).not.toContain("[options]");
	});

	it("filters an alias equal to the command name and accepts a string _aliases value", () => {
		const help = plainHelp();
		process.stdout.columns = 200; // keep alias lines on one line for exact matching
		const program = new Command("root");

		const subA = program.command("subA");
		subA._aliases = ["a1", "subA", "a2"]; // array; own-name entry filtered out

		const subB = program.command("subB");
		subB._aliases = "b1"; // string, differs from name

		const subC = program.command("subC");
		subC._aliases = "subC"; // string equal to name → produces no alias line

		program.command("subD"); // default (empty) aliases → no alias line

		const out = help.formatHelp(program, help);
		const aliasLines = out.split("\n").filter((l) => l.includes("- Aliases:"));
		expect(aliasLines).toHaveLength(2);
		expect(out).toContain("- Aliases: a1, a2");
		expect(out).toContain("- Aliases: b1");
	});

	it("wraps a long subcommand description with a hanging indent", () => {
		const help = plainHelp();
		process.stdout.columns = 40; // force the description to wrap
		const program = new Command("root");
		program
			.command("deploy")
			.description(
				"This is a deliberately long subcommand description that must wrap across several lines to exercise the hanging indent code path fully and thoroughly."
			);

		const out = help.formatHelp(program, help);
		const lines = out.split("\n");
		const descIdx = lines.findIndex((l) => l.includes("- Description:"));
		expect(descIdx).toBeGreaterThan(-1);

		// The line after the label is an indented continuation (not a new "- " bullet).
		const continuation = lines[descIdx + 1];
		expect(continuation.trim().length).toBeGreaterThan(0);
		expect(continuation.startsWith(" ")).toBe(true);
		expect(continuation.trimStart().startsWith("- ")).toBe(false);

		// Words survive the wrap unbroken.
		expect(out).toContain("deliberately");
		expect(out).toContain("thoroughly");
	});
});

describe("collectExamples (via help)", () => {
	it("aggregates examples from the whole tree at the top level", () => {
		const help = plainHelp();
		const program = new Command("root");
		program._exampleList = ["$ root top"];
		program.command("a")._exampleList = ["$ root a"];
		program.command("b")._exampleList = ["$ root b"];

		const out = help.formatHelp(program, help);
		expect(out).toContain("$ root top");
		expect(out).toContain("$ root a");
		expect(out).toContain("$ root b");
	});

	it("caps the top-level example list at five entries", () => {
		const help = plainHelp();
		const program = new Command("root");
		program._exampleList = ["$ e1", "$ e2", "$ e3"];
		program.command("a")._exampleList = ["$ e4", "$ e5"];
		program.command("b")._exampleList = ["$ e6", "$ e7"];

		const out = help.formatHelp(program, help);
		const exampleLines = out.split("\n").filter((l) => /^\s+\$ e\d/.test(l));
		expect(exampleLines).toHaveLength(5);
	});

	it("synthesizes a '$ chain sub <args>' example for a nested command, deduping by name", () => {
		const help = plainHelp();

		// Own example does not mention the sub → synthetic example is added.
		const p1 = new Command("git-embedded");
		const restore1 = p1.command("restore");
		restore1._exampleList = ["$ git-embedded restore"];
		restore1.command("inner").argument("<name>", "n").argument("[extra]");
		const out1 = help.formatHelp(restore1, help);
		expect(out1).toContain("$ git-embedded restore");
		expect(out1).toContain("$ git-embedded restore inner <name> [extra]");

		// Own example already mentions the sub → synthetic example is suppressed.
		const p2 = new Command("git-embedded");
		const restore2 = p2.command("restore");
		restore2._exampleList = ["$ git-embedded restore inner --now"];
		restore2.command("inner").argument("<name>", "n");
		const out2 = help.formatHelp(restore2, help);
		expect(out2).toContain("$ git-embedded restore inner --now");
		expect(out2).not.toContain("$ git-embedded restore inner <name>");
	});
});

describe("applyCustomHelpRecursive (end-to-end via helpInformation)", () => {
	it("wires createHelp, showHelpAfterError, and the help option across the tree", () => {
		const { CustomHelp, applyCustomHelpRecursive } = build();
		const program = new Command();
		program
			.name("git-embedded")
			.description("Root desc")
			.configureOutput({ writeErr: () => {} });
		const sub = program.command("restore").description("Restore desc");

		applyCustomHelpRecursive(program);

		expect(program._showHelpAfterError).toBe(true);
		expect(sub._showHelpAfterError).toBe(true);
		expect(typeof program.createHelp).toBe("function");
		expect(program.createHelp()).toBeInstanceOf(CustomHelp);

		const info = program.helpInformation();
		expect(info).toContain("Usage: git-embedded");
		expect(info).toContain("Root desc");
		// ensureHelpOption installed our custom help description.
		expect(info).toContain("Show help for this command");
		expect(info).toContain("For more information, use a command with help, --help, or -h.");

		// Recursion reached the subcommand: its help renders in the custom format too.
		const subInfo = sub.helpInformation();
		expect(subInfo).toContain("Usage: git-embedded restore");
		expect(subInfo).toContain("For more information, use a command with help, --help, or -h.");
	});

	it("tolerates a command-like object without showHelpAfterError", () => {
		const { CustomHelp, applyCustomHelpRecursive } = build();
		// A minimal duck-typed command (e.g. a plugin-provided one) that lacks
		// showHelpAfterError must not fault the guarded call.
		const calls = [];
		const cmd = {
			helpOption: (...a) => calls.push(a),
			options: [],
			commands: []
		};
		expect(() => applyCustomHelpRecursive(cmd)).not.toThrow();
		expect(typeof cmd.createHelp).toBe("function");
		expect(cmd.createHelp()).toBeInstanceOf(CustomHelp);
		expect(calls).toHaveLength(1); // ensureHelpOption still ran
	});
});
