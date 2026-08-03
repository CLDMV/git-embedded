import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getApi } from "./_setup.mjs";

/**
 * Low-level helper coverage: src/api/git.mjs, paths.mjs, report.mjs, log.mjs,
 * and messages/load.mjs. Exercised through the composed slothlet api (matching
 * the house style) against real temp git repos and temp XDG state/config dirs.
 */

const tmpRoots = [];

function mkTmp() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-embedded-helpers-"));
	tmpRoots.push(dir);
	return dir;
}

function git(args, cwd) {
	const res = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (res.status !== 0) throw new Error(`git ${args.join(" ")} (cwd=${cwd}) failed: ${res.stderr || res.stdout}`);
	return (res.stdout || "").trim();
}

/** A minimal real git repo (no commit needed for config / rev-parse reads). */
function makeRepo() {
	const dir = mkTmp();
	git(["init", "-q", "-b", "main", dir]);
	return dir;
}

/** Write a standalone git config file and return its path (for GIT_CONFIG_GLOBAL). */
function writeConfigFile(body) {
	const f = path.join(mkTmp(), "gitconfig");
	fs.writeFileSync(f, body);
	return f;
}

/** Run fn with process.cwd() temporarily switched — for helpers that read cwd. */
function withCwd(dir, fn) {
	const prev = process.cwd();
	process.chdir(dir);
	try {
		return fn();
	} finally {
		process.chdir(prev);
	}
}

const stripAnsi = (s) => String(s).replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"), "");

let originalEnv;
let originalCwd;

beforeEach(() => {
	originalEnv = { ...process.env };
	originalCwd = process.cwd();
	// Hermetic git: ignore host/global/system config; supply a commit identity.
	process.env.GIT_CONFIG_GLOBAL = os.platform() === "win32" ? "NUL" : "/dev/null";
	process.env.GIT_CONFIG_SYSTEM = os.platform() === "win32" ? "NUL" : "/dev/null";
	process.env.GIT_AUTHOR_NAME = "test";
	process.env.GIT_AUTHOR_EMAIL = "test@example.com";
	process.env.GIT_COMMITTER_NAME = "test";
	process.env.GIT_COMMITTER_EMAIL = "test@example.com";
	// Isolate the transaction-log location so log.append never touches real state.
	const sd = mkTmp();
	process.env.XDG_STATE_HOME = sd;
	if (process.platform === "win32") process.env.LOCALAPPDATA = sd;
});

afterEach(() => {
	try {
		process.chdir(originalCwd);
	} catch {
		// ignore
	}
	process.env = originalEnv;
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

describe("api.git config + repo discovery", () => {
	it("getConfig reads scoped and merged keys and returns null for an absent key", () => {
		const repo = makeRepo();
		git(["config", "--local", "sample.key", "hello"], repo);
		withCwd(repo, () => {
			expect(api.git.getConfig("sample.key", "local")).toBe("hello");
			expect(api.git.getConfig("sample.key")).toBe("hello"); // merged, no scope arg
			expect(api.git.getConfig("no.suchkey", "local")).toBeNull();
			expect(api.git.getConfig("no.suchkey")).toBeNull();
		});
	});

	it("getConfig reads a global-scope key via GIT_CONFIG_GLOBAL", () => {
		process.env.GIT_CONFIG_GLOBAL = writeConfigFile("[sample]\n\tkey = global-val\n");
		expect(api.git.getConfig("sample.key", "global")).toBe("global-val");
		expect(api.git.getConfig("absent.key", "global")).toBeNull();
	});

	it("getRepoRoot / getGitDir resolve inside a repo and are null outside one", () => {
		const repo = makeRepo();
		const root = api.git.getRepoRoot(repo);
		expect(root).not.toBeNull();
		expect(fs.realpathSync(root)).toBe(fs.realpathSync(repo));

		const gitDir = api.git.getGitDir(repo);
		expect(gitDir).not.toBeNull();
		expect(path.basename(gitDir)).toBe(".git");
		expect(fs.existsSync(gitDir)).toBe(true);

		const nonRepo = mkTmp();
		expect(api.git.getRepoRoot(nonRepo)).toBeNull();
		expect(api.git.getGitDir(nonRepo)).toBeNull();
	});

	it("getEffectiveHooksPath returns an absolute core.hooksPath unchanged", () => {
		const repo = makeRepo();
		const abs = path.join(mkTmp(), "abs-hooks");
		git(["config", "--local", "core.hooksPath", abs], repo);
		expect(api.git.getEffectiveHooksPath(repo)).toBe(abs);
	});

	it("getEffectiveHooksPath resolves a relative core.hooksPath against the repo root", () => {
		const repo = makeRepo();
		git(["config", "--local", "core.hooksPath", "team-hooks"], repo);
		expect(api.git.getEffectiveHooksPath(repo)).toBe(path.join(api.git.getRepoRoot(repo), "team-hooks"));
	});

	it("getEffectiveHooksPath expands a leading ~ against the home directory", () => {
		const repo = makeRepo();
		git(["config", "--local", "core.hooksPath", "~/tilde-hooks"], repo);
		expect(api.git.getEffectiveHooksPath(repo)).toBe(path.join(os.homedir(), "tilde-hooks"));
	});

	it("getEffectiveHooksPath returns null when core.hooksPath is unset or empty", () => {
		const repo = makeRepo();
		expect(api.git.getEffectiveHooksPath(repo)).toBeNull(); // unset → git exits non-zero
		git(["config", "--local", "core.hooksPath", ""], repo);
		expect(api.git.getEffectiveHooksPath(repo)).toBeNull(); // present-but-empty → !raw guard
	});

	it("getEffectiveHooksPath resolves a relative path against cwd when not in a repo", () => {
		const nonRepo = mkTmp();
		process.env.GIT_CONFIG_GLOBAL = writeConfigFile("[core]\n\thooksPath = rel-hooks\n");
		expect(api.git.getRepoRoot(nonRepo)).toBeNull(); // precondition: genuinely not a repo
		expect(api.git.getEffectiveHooksPath(nonRepo)).toBe(path.resolve(nonRepo, "rel-hooks"));
	});

	it("getAllHooksPathScopes reports each scope independently", () => {
		const repo = makeRepo();
		git(["config", "--local", "core.hooksPath", ".githooks"], repo);
		process.env.GIT_CONFIG_GLOBAL = writeConfigFile("[core]\n\thooksPath = /global/hooks\n");
		withCwd(repo, () => {
			const scopes = api.git.getAllHooksPathScopes();
			expect(scopes.local).toBe(".githooks");
			expect(scopes.global).toBe("/global/hooks");
			expect(scopes.system).toBeNull(); // GIT_CONFIG_SYSTEM=/dev/null
		});
	});

	it("getInitTemplateDir expands ~, passes an absolute path through, and is null when unset", () => {
		// Unset: GIT_CONFIG_GLOBAL=/dev/null from beforeEach → no init.templateDir.
		expect(api.git.getInitTemplateDir()).toBeNull();
		// Leading ~ expands against the home directory.
		process.env.GIT_CONFIG_GLOBAL = writeConfigFile("[init]\n\ttemplateDir = ~/my-template\n");
		expect(api.git.getInitTemplateDir()).toBe(path.join(os.homedir(), "my-template"));
		// Absolute path is returned verbatim.
		process.env.GIT_CONFIG_GLOBAL = writeConfigFile("[init]\n\ttemplateDir = /opt/tpl\n");
		expect(api.git.getInitTemplateDir()).toBe("/opt/tpl");
	});
});

describe("api.paths", () => {
	it("packageRoot / hooksSourceDir / messagesDir resolve to real directories under the package", () => {
		const root = api.paths.packageRoot();
		expect(typeof root).toBe("string");
		expect(fs.existsSync(root)).toBe(true);
		expect(api.paths.hooksSourceDir()).toBe(path.join(root, "hooks"));
		expect(api.paths.messagesDir()).toBe(path.join(root, "messages"));
		expect(fs.existsSync(api.paths.hooksSourceDir())).toBe(true);
		expect(fs.existsSync(api.paths.messagesDir())).toBe(true);
	});

	it.skipIf(process.platform === "win32")("stateDir uses XDG_STATE_HOME when set", () => {
		const base = mkTmp();
		process.env.XDG_STATE_HOME = base;
		expect(api.paths.stateDir()).toBe(path.join(base, "git-embedded"));
	});

	it.skipIf(process.platform === "win32")("stateDir falls back to ~/.local/state when XDG_STATE_HOME is unset", () => {
		delete process.env.XDG_STATE_HOME;
		expect(api.paths.stateDir()).toBe(path.join(os.homedir(), ".local", "state", "git-embedded"));
	});

	it.skipIf(process.platform === "win32")("stateDir treats an empty XDG_STATE_HOME as unset", () => {
		process.env.XDG_STATE_HOME = "";
		expect(api.paths.stateDir()).toBe(path.join(os.homedir(), ".local", "state", "git-embedded"));
	});

	it.skipIf(process.platform === "win32")("transactionLogPath is stateDir/install.log", () => {
		const base = mkTmp();
		process.env.XDG_STATE_HOME = base;
		expect(api.paths.transactionLogPath()).toBe(path.join(base, "git-embedded", "install.log"));
	});

	it("defaultGlobalDispatcherDir uses XDG_CONFIG_HOME when set", () => {
		const base = mkTmp();
		process.env.XDG_CONFIG_HOME = base;
		expect(api.paths.defaultGlobalDispatcherDir()).toBe(path.join(base, "git", "hooks"));
	});

	it("defaultGlobalDispatcherDir falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
		delete process.env.XDG_CONFIG_HOME;
		expect(api.paths.defaultGlobalDispatcherDir()).toBe(path.join(os.homedir(), ".config", "git", "hooks"));
	});

	it("defaultGlobalDispatcherDir treats an empty XDG_CONFIG_HOME as unset", () => {
		process.env.XDG_CONFIG_HOME = "";
		expect(api.paths.defaultGlobalDispatcherDir()).toBe(path.join(os.homedir(), ".config", "git", "hooks"));
	});
});

describe("api.report output helpers", () => {
	it("success/warn/plain go to stdout and error goes to stderr, each with its glyph", () => {
		const out = [];
		const err = [];
		vi.spyOn(console, "log").mockImplementation((...a) => out.push(a.map(String).join(" ")));
		vi.spyOn(console, "error").mockImplementation((...a) => err.push(a.map(String).join(" ")));

		api.report.success("saved ok");
		api.report.warn("careful now");
		api.report.error("it broke");
		api.report.plain("just text");
		api.report.plain(); // default empty line

		const outJoined = out.map(stripAnsi).join("\n");
		const errJoined = err.map(stripAnsi).join("\n");
		expect(outJoined).toContain("✓ saved ok"); // ✓
		expect(outJoined).toContain("! careful now");
		expect(outJoined).toContain("just text");
		expect(out).toContain(""); // plain() with no arg logs the empty string
		expect(errJoined).toContain("✗ it broke"); // ✗
		expect(outJoined).not.toContain("it broke"); // error must not leak to stdout
	});

	it("detectionHeader renders every populated field with a known-kind label", () => {
		const out = [];
		vi.spyOn(console, "log").mockImplementation((...a) => out.push(a.map(String).join(" ")));

		api.report.detectionHeader({
			kind: "husky",
			paths: { repoRoot: "/r/root", gitDir: "/r/root/.git", effectiveHooksPath: "/r/hooks" },
			signals: {
				hooksPathScopes: { system: "/sys", global: "/glob", local: null },
				initTemplateDir: "/tpl"
			},
			dispatcher: { dispatcherPath: "/disp/_dispatch", missing: ["post-rewrite", "reference-transaction"] },
			foreign: { dir: "/foreign/dir", configFile: "/foreign/cfg.yml" },
			bare: { dir: "/bare/hooks" },
			subClassification: { dispatcherPath: "/sys/_dispatch" }
		});

		const text = stripAnsi(out.join("\n"));
		expect(text).toContain("Detected: Husky"); // KIND_LABELS lookup
		expect(text).toContain("Repo root");
		expect(text).toContain("/r/root");
		expect(text).toContain("Git dir");
		expect(text).toContain("/r/root/.git");
		expect(text).toContain("Effective core.hooksPath");
		expect(text).toContain("/r/hooks");
		expect(text).toContain("core.hooksPath scopes");
		expect(text).toContain("system=/sys");
		expect(text).toContain("global=/glob");
		expect(text).not.toContain("local="); // local was null → dropped from the parts
		expect(text).toContain("init.templateDir");
		expect(text).toContain("/tpl");
		expect(text).toContain("Dispatcher");
		expect(text).toContain("/disp/_dispatch");
		expect(text).toContain("Missing entries");
		expect(text).toContain("post-rewrite, reference-transaction");
		expect(text).toContain("Tool directory");
		expect(text).toContain("/foreign/dir");
		expect(text).toContain("Config file");
		expect(text).toContain("/foreign/cfg.yml");
		expect(text).toContain("Hooks directory");
		expect(text).toContain("/bare/hooks");
		expect(text).toContain("System-path dispatcher");
		expect(text).toContain("/sys/_dispatch");
	});

	it("detectionHeader falls back to the raw kind for an unknown label and prints no field lines", () => {
		const out = [];
		vi.spyOn(console, "log").mockImplementation((...a) => out.push(a.map(String).join(" ")));
		api.report.detectionHeader({ kind: "mystery-kind" });
		const text = stripAnsi(out.join("\n"));
		expect(text).toContain("Detected: mystery-kind"); // unknown kind → raw value
		expect(text).not.toContain("Repo root");
		expect(text).not.toContain("Dispatcher");
	});

	it("detectionHeader omits empty/null field values and all-null scope maps", () => {
		const out = [];
		vi.spyOn(console, "log").mockImplementation((...a) => out.push(a.map(String).join(" ")));
		api.report.detectionHeader({
			kind: "none",
			paths: { repoRoot: "", gitDir: null, effectiveHooksPath: undefined },
			signals: { hooksPathScopes: { system: null, global: null, local: null } },
			foreign: { dir: "" }
		});
		const text = stripAnsi(out.join("\n"));
		expect(text).toContain("Detected: No hook setup detected"); // KIND_LABELS.none
		expect(text).not.toContain("Repo root"); // fmtKv("", …) → null → filtered
		expect(text).not.toContain("Git dir");
		expect(text).not.toContain("Tool directory");
		expect(text).not.toContain("core.hooksPath scopes"); // parts empty → no line
	});

	it("message renders a known kind's markdown to stdout ending in a newline", () => {
		const writes = [];
		vi.spyOn(process.stdout, "write").mockImplementation((s) => {
			writes.push(String(s));
			return true;
		});
		api.report.message("none");
		const rendered = writes.join("");
		expect(rendered.length).toBeGreaterThan(0);
		expect(rendered.endsWith("\n")).toBe(true);
	});

	it("message throws for an unknown kind (propagated from messages.load)", () => {
		expect(() => api.report.message("does-not-exist")).toThrow(/Unknown message kind/);
	});
});

describe("api.log transaction log", () => {
	it("append writes timestamped JSONL entries that read parses back in order", () => {
		expect(api.log.read()).toEqual([]); // fresh state dir → no log yet
		expect(fs.existsSync(api.log.path())).toBe(false);

		api.log.append({ op: "install-repo-hook", path: "/x/hooks/pre-push" });
		api.log.append({ op: "uninstall-repo-hook", path: "/x/hooks/pre-push" });

		expect(fs.existsSync(api.log.path())).toBe(true);
		const entries = api.log.read();
		expect(entries).toHaveLength(2);
		expect(entries[0].op).toBe("install-repo-hook");
		expect(entries[1].op).toBe("uninstall-repo-hook");
		expect(entries[0].path).toBe("/x/hooks/pre-push");
		expect(typeof entries[0].ts).toBe("string");
		expect(entries[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO timestamp stamped by append

		// path() mirrors paths.transactionLogPath() and lives under the temp state dir.
		expect(api.log.path()).toBe(api.paths.transactionLogPath());
		expect(api.log.path()).toBe(path.join(process.env.XDG_STATE_HOME, "git-embedded", "install.log"));
	});

	it("read skips malformed lines and returns only the valid JSON entries", () => {
		const logPath = api.log.path();
		fs.mkdirSync(path.dirname(logPath), { recursive: true });
		fs.writeFileSync(logPath, [JSON.stringify({ op: "a" }), "this is not json {{{", "", JSON.stringify({ op: "b" })].join("\n") + "\n");
		const entries = api.log.read();
		expect(entries).toHaveLength(2); // blank + garbage lines dropped
		expect(entries.map((e) => e.op)).toEqual(["a", "b"]);
	});

	it("read returns an empty array when the log file does not exist", () => {
		expect(fs.existsSync(api.log.path())).toBe(false);
		expect(api.log.read()).toEqual([]);
	});
});

describe("api.messages.load", () => {
	it("returns the verbatim markdown body for a known kind", () => {
		const body = api.messages.load("none");
		const onDisk = fs.readFileSync(path.join(api.paths.messagesDir(), "setup-none.md"), "utf8");
		expect(body).toBe(onDisk);
		expect(body.length).toBeGreaterThan(0);
	});

	it("throws for an unknown kind", () => {
		expect(() => api.messages.load("no-such-kind")).toThrow(/Unknown message kind: no-such-kind/);
	});
});
