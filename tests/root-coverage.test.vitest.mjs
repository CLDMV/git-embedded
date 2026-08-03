import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import { Command, Help } from "commander";
import { makeCustomHelp } from "../src/api/commander/custom-help.mjs";
import { getApi } from "./_setup.mjs";

// node:readline's ES module namespace object cannot be vi.spyOn'd directly —
// its properties are non-configurable (confirmed: `vi.spyOn(readlineNs,
// "createInterface")` throws "Module namespace is not configurable in ESM").
// A full module mock is the supported way to control what
// context.readline.createInterface() returns for api.prompt.confirm's
// interactive branch. vi.mock is hoisted above every import in this file
// (including the transitive "node:readline" import inside _setup.mjs), so
// the composed api's context.readline resolves to this mock.
const { createInterfaceMock } = vi.hoisted(() => ({ createInterfaceMock: vi.fn() }));
vi.mock("node:readline", () => ({
	createInterface: createInterfaceMock,
	default: { createInterface: createInterfaceMock }
}));

/**
 * Coverage top-up for src/api/prompt.mjs, paths.mjs, git.mjs, report.mjs, and
 * src/api/commander/custom-help.mjs — closing the line/branch/function gaps
 * left after tests/helpers.test.vitest.mjs and tests/commander-help.test.vitest.mjs.
 *
 * Same house style as those two files: exercise the composed slothlet api
 * against real temp git repos / XDG dirs (git.mjs, paths.mjs, report.mjs),
 * and a real commander Command tree through the directly-imported
 * custom-help.mjs factory (matching commander-help.test.vitest.mjs's pattern).
 * prompt.mjs is the one exception that needs the readline module mock above
 * to drive its interactive path deterministically.
 */

const tmpRoots = [];

function mkTmp() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-embedded-rootcov-"));
	tmpRoots.push(dir);
	return dir;
}

const stripAnsi = (s) => String(s).replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"), "");

let originalEnv;
let originalCwd;
let originalIsTTYDescriptor;
let originalPlatformDescriptor;

beforeEach(() => {
	originalEnv = { ...process.env };
	originalCwd = process.cwd();
	originalIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
	// Hermetic git: ignore host/global/system config; supply a commit identity.
	process.env.GIT_CONFIG_GLOBAL = os.platform() === "win32" ? "NUL" : "/dev/null";
	process.env.GIT_CONFIG_SYSTEM = os.platform() === "win32" ? "NUL" : "/dev/null";
	process.env.GIT_AUTHOR_NAME = "test";
	process.env.GIT_AUTHOR_EMAIL = "test@example.com";
	process.env.GIT_COMMITTER_NAME = "test";
	process.env.GIT_COMMITTER_EMAIL = "test@example.com";
	// Isolate the transaction-log/state location.
	const sd = mkTmp();
	process.env.XDG_STATE_HOME = sd;
	if (process.platform === "win32") process.env.LOCALAPPDATA = sd;
	createInterfaceMock.mockReset();
});

afterEach(() => {
	try {
		process.chdir(originalCwd);
	} catch {
		// ignore
	}
	process.env = originalEnv;
	if (originalIsTTYDescriptor) Object.defineProperty(process.stdin, "isTTY", originalIsTTYDescriptor);
	else delete process.stdin.isTTY;
	if (originalPlatformDescriptor) Object.defineProperty(process, "platform", originalPlatformDescriptor);
	vi.restoreAllMocks();
	while (tmpRoots.length) {
		const d = tmpRoots.pop();
		try {
			fs.rmSync(d, { recursive: true, force: true });
		} catch {
			// ignore
		}
	}
});

let api;
beforeAll(async () => {
	api = await getApi();
});

// ---------------------------------------------------------------------------
// api.prompt.confirm
// ---------------------------------------------------------------------------

describe("api.prompt.confirm", () => {
	it("yes:true bypasses TTY/readline entirely and resolves true", async () => {
		createInterfaceMock.mockImplementation(() => {
			throw new Error("createInterface must not be called when opts.yes is true");
		});
		await expect(api.prompt.confirm("Proceed?", { yes: true })).resolves.toBe(true);
		expect(createInterfaceMock).not.toHaveBeenCalled();
	});

	it("non-interactive (no TTY) returns defaultYes without prompting; also covers the omitted-opts default", async () => {
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

		// opts entirely omitted → opts defaults to {}, and defaultYes/yes both take
		// their destructuring defaults (false) in the same call.
		await expect(api.prompt.confirm("Proceed?")).resolves.toBe(false);
		// Explicit defaultYes:true on the same non-interactive path.
		await expect(api.prompt.confirm("Proceed?", { defaultYes: true })).resolves.toBe(true);
		// Explicit yes:false is indistinguishable from omitted but exercises the
		// destructuring default path via a real (not implicit) opts object too.
		await expect(api.prompt.confirm("Proceed?", { yes: false, defaultYes: false })).resolves.toBe(false);

		expect(createInterfaceMock).not.toHaveBeenCalled();
	});

	it("interactive: answer 'y' resolves true and renders the [y/N] suffix for defaultYes:false", async () => {
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		const questionMock = vi.fn((_q, cb) => cb("y"));
		const closeMock = vi.fn();
		createInterfaceMock.mockReturnValue({ question: questionMock, close: closeMock });

		await expect(api.prompt.confirm("Continue?", { defaultYes: false })).resolves.toBe(true);

		expect(createInterfaceMock).toHaveBeenCalledWith({ input: process.stdin, output: process.stdout });
		expect(questionMock).toHaveBeenCalledTimes(1);
		expect(questionMock.mock.calls[0][0]).toBe("Continue? [y/N] ");
		expect(closeMock).toHaveBeenCalledTimes(1);
	});

	it("interactive: whitespace/mixed-case 'YES' resolves true and renders the [Y/n] suffix for defaultYes:true", async () => {
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		const questionMock = vi.fn((_q, cb) => cb("  YES  "));
		createInterfaceMock.mockReturnValue({ question: questionMock, close: vi.fn() });

		await expect(api.prompt.confirm("Continue?", { defaultYes: true })).resolves.toBe(true);

		expect(questionMock.mock.calls[0][0]).toBe("Continue? [Y/n] ");
	});

	it("interactive: an empty answer resolves defaultYes, both when true and false", async () => {
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

		createInterfaceMock.mockReturnValue({ question: (_q, cb) => cb(""), close: vi.fn() });
		await expect(api.prompt.confirm("Continue?", { defaultYes: true })).resolves.toBe(true);

		createInterfaceMock.mockReturnValue({ question: (_q, cb) => cb(""), close: vi.fn() });
		await expect(api.prompt.confirm("Continue?", { defaultYes: false })).resolves.toBe(false);
	});

	it("interactive: any other answer (e.g. 'no') resolves false regardless of defaultYes", async () => {
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		createInterfaceMock.mockReturnValue({ question: (_q, cb) => cb("no"), close: vi.fn() });

		await expect(api.prompt.confirm("Continue?", { defaultYes: true })).resolves.toBe(false);
	});
});

// ---------------------------------------------------------------------------
// api.paths — win32 branch of stateDir()
// ---------------------------------------------------------------------------

describe("api.paths.stateDir on win32", () => {
	function setWin32() {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
	}

	it("uses LOCALAPPDATA when set", () => {
		setWin32();
		const fakeLocal = mkTmp();
		process.env.LOCALAPPDATA = fakeLocal;
		expect(api.paths.stateDir()).toBe(path.join(fakeLocal, "git-embedded"));
	});

	it("falls back to homedir/AppData/Local when LOCALAPPDATA is unset", () => {
		setWin32();
		delete process.env.LOCALAPPDATA;
		expect(api.paths.stateDir()).toBe(path.join(os.homedir(), "AppData", "Local", "git-embedded"));
	});
});

// ---------------------------------------------------------------------------
// api.git — defensive fallback reachable only when the git binary is missing
// ---------------------------------------------------------------------------

describe("api.git — run() when the git binary itself cannot be spawned", () => {
	it.skipIf(process.platform === "win32")("getConfig returns null (not throw) when PATH has no git binary", () => {
		const prevPath = process.env.PATH;
		process.env.PATH = "";
		try {
			// spawnSync("git", ...) fails with ENOENT: res.status is null, so
			// `res.status ?? 1` falls back to 1 (not 0) → getConfig sees code!==0.
			expect(api.git.getConfig("core.hooksPath")).toBeNull();
		} finally {
			process.env.PATH = prevPath;
		}
	});
});

// ---------------------------------------------------------------------------
// api.report — edge-case input that reaches fmtKv's internal null/empty guard
// ---------------------------------------------------------------------------

describe("api.report.detectionHeader — edge cases", () => {
	it("omits the Missing entries line when the missing array joins to an empty string", () => {
		const out = [];
		vi.spyOn(console, "log").mockImplementation((...a) => out.push(a.map(String).join(" ")));

		// dispatcher.missing.length (1) passes detectionHeader's own guard, but
		// [""].join(", ") is "" — reaching fmtKv's internal `value === ""` check,
		// which every OTHER call site in detectionHeader already guards against
		// before calling fmtKv at all.
		api.report.detectionHeader({
			kind: "dispatcher-missing-symlinks",
			dispatcher: { dispatcherPath: "/d/_dispatch", missing: [""] }
		});

		const text = stripAnsi(out.join("\n"));
		expect(text).toContain("Dispatcher");
		expect(text).toContain("/d/_dispatch");
		expect(text).not.toContain("Missing entries");
	});
});

// ---------------------------------------------------------------------------
// src/api/commander/custom-help.mjs — remaining branches
// (direct-import style, matching tests/commander-help.test.vitest.mjs)
// ---------------------------------------------------------------------------

function buildCustomHelp() {
	return makeCustomHelp(Help, { chalk });
}

function plainCustomHelp() {
	return new (buildCustomHelp().CustomHelp)({ colorMode: "never" });
}

describe("custom-help.mjs — remaining branches", () => {
	it("omits the Options section entirely when a command has no visible options at all", () => {
		const help = plainCustomHelp();
		const cmd = new Command("bare");
		cmd.helpOption(false); // removes the default -h/--help too
		const out = help.formatHelp(cmd, help);
		expect(out).not.toContain("Options:");
	});

	it("falls back to c.description() when the passed-in helper has no commandDescription method", () => {
		const help = plainCustomHelp();
		const program = new Command("root");
		program.command("worker").description("Do background work.");

		// A helper that behaves like a real Help instance for everything else,
		// but shadows commandDescription with an own falsy property.
		const fakeHelper = Object.create(help);
		fakeHelper.commandDescription = undefined;

		const out = help.formatHelp(program, fakeHelper);
		expect(out).toContain("worker");
		expect(out).toContain("Do background work.");
	});

	it("stops walking the parent chain at an ancestor without a .name function", () => {
		const help = plainCustomHelp();
		const program = new Command("root");
		const child = program.command("child");
		child.parent = { notACommand: true }; // malformed ancestor: no .name at all
		const out = help.formatHelp(child, help);
		expect(out.split("\n")[0]).toContain("Usage: child");
		expect(out.split("\n")[0]).not.toContain("root");
	});

	it("skips an empty command name when building the usage chain", () => {
		const help = plainCustomHelp();
		const bare = new Command(); // no name → name() returns ""
		bare.helpOption(false);
		expect(help.formatHelp(bare, help).split("\n")[0]).toBe("Usage: ");
	});

	it("defaults a subcommand's args to none in a synthesized example when _args is missing", () => {
		const help = plainCustomHelp();
		const program = new Command("root");
		const restore = program.command("restore");
		const inner = restore.command("inner");
		delete inner._args; // simulate a foreign/malformed command node

		const out = help.formatHelp(restore, help); // non-top-level → collectExamples's sub._args path
		expect(out).toContain("$ root restore inner");
	});

	it("stops the top-level examples walk at a node with no .commands array", () => {
		const help = plainCustomHelp();
		const program = new Command("root"); // top-level → collectExamples's walk() path
		const child = program.command("child");
		child._exampleList = ["$ root child --now"];
		delete child.commands; // malformed node: walk() must stop, not crash

		const out = help.formatHelp(program, help);
		expect(out).toContain("$ root child --now");
	});

	it("produces no Aliases line when the alias list joins to an empty string", () => {
		const help = plainCustomHelp();
		const program = new Command("root");
		const sub = program.command("sub");
		sub._aliases = [""]; // survives the `!== name()` filter but joins to ""

		const out = help.formatHelp(program, help);
		expect(out).not.toContain("Aliases:");
	});
});
