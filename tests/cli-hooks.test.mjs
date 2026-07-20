/**
 *	@Project: @cldmv/git-embedded
 *	@Filename: /tests/cli-hooks.test.mjs
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 * Behavior tests for the CLI wrapper commands that manage git hooks and print
 * misc info, driven through the composed slothlet api against REAL temp git
 * repos (per the house style). Covers:
 *
 * - install-hooks: the detection-driven switch (refuse / suggest-dispatcher /
 *   heal-then-install / install), the per-repo install (owned-copy + foreign
 *   skip), the dispatcher bootstrap (+ global core.hooksPath), and the heal.
 * - uninstall-hooks: removes only git-embedded-owned hooks, keeps foreign ones,
 *   reports "none found", and refuses outside a repo.
 * - install-template: templateDir resolution, confirm gate, --force overwrite.
 * - print-hook-script: known-name passthrough to stdout + unknown-name refusal.
 * - version / doctor / init: the small wrappers around package.json, detection,
 *   and the install-hooks + advice-silencing composition.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getApi } from "./_setup.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const hooksSrcDir = path.join(packageRoot, "hooks");

// The five hook names git-embedded owns, and where each one's body comes from.
const PACKAGE_HOOKS = ["post-checkout", "post-merge", "post-rewrite", "reference-transaction", "pre-push"];
const REQUIRED_HOOKS = ["post-checkout", "post-merge", "post-rewrite", "reference-transaction"];
const STANDARD_HOOK_NAMES = [
	"applypatch-msg",
	"commit-msg",
	"post-applypatch",
	"post-checkout",
	"post-commit",
	"post-merge",
	"post-rewrite",
	"pre-applypatch",
	"pre-auto-gc",
	"pre-commit",
	"pre-merge-commit",
	"pre-push",
	"pre-rebase",
	"prepare-commit-msg",
	"reference-transaction"
];

// A canonical chaining dispatcher body (matches the classifier's chain check).
const CHAINING_DISPATCHER = `#!/bin/sh
# git-embedded-compatible dispatcher
hook=$(basename "$0")
git_dir=$(git rev-parse --absolute-git-dir 2>/dev/null) || exit 0
repo_hook="$git_dir/hooks/$hook"
if [ -x "$repo_hook" ] && [ "$repo_hook" != "$0" ]; then
    exec "$repo_hook" "$@"
fi
exit 0
`;

const tmpRoots = [];
function mkTmp(prefix = "git-embedded-cli-") {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tmpRoots.push(dir);
	return dir;
}

// Whether this environment can CREATE symlinks. The dispatcher fixtures + the
// bootstrap/heal link mechanisms need them; on Windows without Developer Mode
// creation is denied, so those cases skip (the copy-based paths still run).
const canSymlink = (() => {
	let dir = null;
	try {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-embedded-symlink-probe-"));
		fs.symlinkSync(dir, path.join(dir, "probe"), "dir");
		return true;
	} catch {
		return false;
	} finally {
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
})();

function git(args, cwd) {
	const res = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (res.status !== 0) throw new Error(`git ${args.join(" ")} (cwd=${cwd}) failed: ${res.stderr || res.stdout}`);
	return (res.stdout || "").trim();
}

/** A plain git repo with one commit. Returns { repo, gitDir }. */
function makeRepo() {
	const repo = path.join(mkTmp(), "repo");
	git(["init", "-b", "main", repo]);
	fs.writeFileSync(path.join(repo, "README.md"), "hi");
	git(["add", "."], repo);
	git(["commit", "-m", "init"], repo);
	return { repo, gitDir: path.join(repo, ".git") };
}

/** Plant a Husky signature at a repo root so detect.run classifies it foreign. */
function plantHusky(repo) {
	fs.mkdirSync(path.join(repo, ".husky"));
	fs.writeFileSync(
		path.join(repo, "package.json"),
		JSON.stringify({ scripts: { prepare: "husky" }, devDependencies: { husky: "^9.0.0" } })
	);
}

/**
 * Build a dispatcher directory: a chaining `_dispatch` plus a symlink for each
 * name in `linked`. With all REQUIRED_HOOKS linked it classifies
 * canonical-complete; with a subset it classifies missing-symlinks.
 */
function makeDispatcherDir(linked) {
	const dir = path.join(mkTmp("git-embedded-disp-"), "hooks");
	fs.mkdirSync(dir, { recursive: true });
	const dispatch = path.join(dir, "_dispatch");
	fs.writeFileSync(dispatch, CHAINING_DISPATCHER);
	fs.chmodSync(dispatch, 0o755);
	for (const name of linked) fs.symlinkSync(dispatch, path.join(dir, name));
	return { dir, dispatch };
}

function stripAnsi(s) {
	// eslint-disable-next-line no-control-regex
	return String(s).replace(/\[[0-9;]*m/g, "");
}

/** Silence + capture console.log / console.error / stdout into one line array. */
function capture() {
	const out = [];
	const push = (s) => out.push(stripAnsi(s));
	vi.spyOn(console, "log").mockImplementation((...a) => push(a.join(" ")));
	vi.spyOn(console, "error").mockImplementation((...a) => push(a.join(" ")));
	vi.spyOn(process.stdout, "write").mockImplementation((c) => {
		push(typeof c === "string" ? c : c.toString("utf8"));
		return true;
	});
	return out;
}

/** Capture raw stdout bytes verbatim (no ANSI stripping) for exact compares. */
function captureStdoutRaw() {
	const chunks = [];
	vi.spyOn(process.stdout, "write").mockImplementation((c) => {
		chunks.push(typeof c === "string" ? c : c.toString("utf8"));
		return true;
	});
	return chunks;
}

function mockExit() {
	return vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new Error(`process.exit(${code})`);
	});
}

let originalEnv;
let originalCwd;

beforeEach(() => {
	originalEnv = { ...process.env };
	originalCwd = process.cwd();
	// Hermetic git: ignore host/global config, supply a commit identity.
	process.env.GIT_CONFIG_GLOBAL = os.platform() === "win32" ? "NUL" : "/dev/null";
	process.env.GIT_CONFIG_SYSTEM = os.platform() === "win32" ? "NUL" : "/dev/null";
	process.env.GIT_AUTHOR_NAME = "test";
	process.env.GIT_AUTHOR_EMAIL = "test@example.com";
	process.env.GIT_COMMITTER_NAME = "test";
	process.env.GIT_COMMITTER_EMAIL = "test@example.com";
	// Redirect XDG so the transaction log + any default dispatcher dir land in
	// throwaway temp dirs, never the real ~/.local/state or ~/.config.
	process.env.XDG_STATE_HOME = mkTmp("git-embedded-state-");
	process.env.XDG_CONFIG_HOME = mkTmp("git-embedded-config-");
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

function assertOwnedHooksInstalled(hooksDir) {
	for (const name of PACKAGE_HOOKS) {
		const p = path.join(hooksDir, name);
		expect(fs.existsSync(p)).toBe(true);
		expect(fs.readFileSync(p, "utf8")).toContain("git-embedded");
	}
}

describe("api.cli.installHooks", () => {
	it("refuses over a foreign manager (husky) and exits 2 without installing", async () => {
		const { repo, gitDir } = makeRepo();
		plantHusky(repo);
		process.chdir(repo);
		capture();
		mockExit();
		await expect(api.cli.installHooks.run({})).rejects.toThrow(/process\.exit\(2\)/);
		// Refuse happens before any install — no package hook was planted.
		expect(fs.existsSync(path.join(gitDir, "hooks", "post-checkout"))).toBe(false);
	});

	it("suggest-dispatcher, declined (non-TTY): falls back to a per-repo install", async () => {
		const { repo, gitDir } = makeRepo();
		process.chdir(repo);
		const out = capture();
		await api.cli.installHooks.run({});
		const text = out.join("\n");
		expect(text).toContain("Dispatcher install declined");
		expect(text).toContain("Installed per-repo hooks");
		assertOwnedHooksInstalled(path.join(gitDir, "hooks"));
	});

	it("per-repo install skips a pre-existing hook that git-embedded does not own", async () => {
		const { repo, gitDir } = makeRepo();
		const foreign = path.join(gitDir, "hooks", "post-checkout");
		fs.writeFileSync(foreign, "#!/bin/sh\necho not ours\n");
		process.chdir(repo);
		const out = capture();
		await api.cli.installHooks.run({});
		const text = out.join("\n");
		expect(text).toContain("Skipped post-checkout");
		// The foreign file is preserved; the other four owned hooks still install.
		expect(fs.readFileSync(foreign, "utf8")).toBe("#!/bin/sh\necho not ours\n");
		for (const name of PACKAGE_HOOKS.filter((n) => n !== "post-checkout")) {
			expect(fs.readFileSync(path.join(gitDir, "hooks", name), "utf8")).toContain("git-embedded");
		}
	});

	it.skipIf(!canSymlink)(
		"suggest-dispatcher, --yes: bootstraps a dispatcher, sets global core.hooksPath, then installs per-repo",
		async () => {
			const { repo, gitDir } = makeRepo();
			const dispatcherDir = path.join(mkTmp(), "global-hooks");
			const globalCfg = path.join(mkTmp(), "gitconfig");
			process.env.GIT_CONFIG_GLOBAL = globalCfg; // writable global so `git config --global` succeeds
			process.chdir(repo);
			const out = capture();

			await api.cli.installHooks.run({ yes: true, dispatcherDir });

			// Dispatcher script + a link for every standard hook name were created.
			expect(fs.existsSync(path.join(dispatcherDir, "_dispatch"))).toBe(true);
			for (const name of STANDARD_HOOK_NAMES) {
				const linkPath = path.join(dispatcherDir, name);
				expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
				expect(path.resolve(fs.readlinkSync(linkPath))).toBe(path.join(dispatcherDir, "_dispatch"));
			}
			// Global core.hooksPath now points at the new dispatcher dir.
			const g = spawnSync("git", ["config", "--global", "--get", "core.hooksPath"], {
				encoding: "utf8",
				env: { ...process.env, GIT_CONFIG_GLOBAL: globalCfg }
			});
			expect((g.stdout || "").trim()).toBe(dispatcherDir);
			// And the per-repo hooks landed too.
			assertOwnedHooksInstalled(path.join(gitDir, "hooks"));
			expect(out.join("\n")).toContain("Dispatcher installed at");
		}
	);

	it.skipIf(!canSymlink)("heal-then-install, --yes: adds the missing dispatcher entries then installs per-repo", async () => {
		const { repo, gitDir } = makeRepo();
		// Dispatcher present but missing two required entries → heal-then-install.
		const { dir: dispatcherDir, dispatch } = makeDispatcherDir(["post-checkout", "post-merge"]);
		git(["config", "--local", "core.hooksPath", dispatcherDir], repo);
		process.chdir(repo);
		const out = capture();

		await api.cli.installHooks.run({ yes: true });

		for (const name of ["post-rewrite", "reference-transaction"]) {
			const linkPath = path.join(dispatcherDir, name);
			expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
			expect(path.resolve(fs.readlinkSync(linkPath))).toBe(dispatch);
		}
		assertOwnedHooksInstalled(path.join(gitDir, "hooks"));
		expect(out.join("\n")).toMatch(/Healed \d+ entries/);
	});

	it.skipIf(!canSymlink)("heal-then-install, declined: warns and exits 2 (adds nothing)", async () => {
		const { repo } = makeRepo();
		const { dir: dispatcherDir } = makeDispatcherDir(["post-checkout", "post-merge"]);
		git(["config", "--local", "core.hooksPath", dispatcherDir], repo);
		process.chdir(repo);
		capture();
		mockExit();
		await expect(api.cli.installHooks.run({})).rejects.toThrow(/process\.exit\(2\)/);
		expect(fs.existsSync(path.join(dispatcherDir, "post-rewrite"))).toBe(false);
	});

	it.skipIf(!canSymlink)("install (canonical-complete dispatcher present): installs per-repo hooks without prompting", async () => {
		const { repo, gitDir } = makeRepo();
		const { dir: dispatcherDir } = makeDispatcherDir(REQUIRED_HOOKS);
		git(["config", "--local", "core.hooksPath", dispatcherDir], repo);
		process.chdir(repo);
		const out = capture();
		await api.cli.installHooks.run({});
		assertOwnedHooksInstalled(path.join(gitDir, "hooks"));
		expect(out.join("\n")).toContain("Installed per-repo hooks");
	});
});

describe("api.cli.uninstallHooks", () => {
	it("removes only git-embedded-owned hooks and keeps a foreign one", async () => {
		const { repo, gitDir } = makeRepo();
		const hooksDir = path.join(gitDir, "hooks");
		api.install.hooks("install", gitDir); // plant all five owned hooks
		// Overwrite one with foreign content so uninstall must keep it.
		fs.writeFileSync(path.join(hooksDir, "pre-push"), "#!/bin/sh\necho foreign pre-push\n");
		process.chdir(repo);
		const out = capture();

		await api.cli.uninstallHooks.run();

		for (const name of REQUIRED_HOOKS) {
			expect(fs.existsSync(path.join(hooksDir, name))).toBe(false);
		}
		expect(fs.readFileSync(path.join(hooksDir, "pre-push"), "utf8")).toBe("#!/bin/sh\necho foreign pre-push\n");
		const text = out.join("\n");
		expect(text).toContain("Removed per-repo hooks");
		expect(text).toContain("Left pre-push in place");
	});

	it("reports nothing to do when no git-embedded hooks are present", async () => {
		const { repo } = makeRepo();
		process.chdir(repo);
		const out = capture();
		await api.cli.uninstallHooks.run();
		expect(out.join("\n")).toContain("No git-embedded hooks found");
	});

	it("refuses outside a git repository and exits 2", async () => {
		const notARepo = mkTmp();
		process.chdir(notARepo);
		capture();
		mockExit();
		await expect(api.cli.uninstallHooks.run()).rejects.toThrow(/process\.exit\(2\)/);
	});
});

describe("api.cli.installTemplate", () => {
	it("errors and exits 2 when no template dir is configured or passed", async () => {
		process.chdir(mkTmp());
		capture();
		mockExit();
		await expect(api.cli.installTemplate.run({})).rejects.toThrow(/process\.exit\(2\)/);
	});

	it("--yes installs the packaged hooks into <templateDir>/hooks", async () => {
		const templateDir = path.join(mkTmp(), "template");
		const out = capture();
		await api.cli.installTemplate.run({ templateDir, yes: true });
		assertOwnedHooksInstalled(path.join(templateDir, "hooks"));
		expect(out.join("\n")).toContain("Installed template hooks");
	});

	it("declined (non-TTY): installs nothing", async () => {
		const templateDir = path.join(mkTmp(), "template");
		const out = capture();
		await api.cli.installTemplate.run({ templateDir });
		expect(fs.existsSync(path.join(templateDir, "hooks", "post-checkout"))).toBe(false);
		expect(out.join("\n")).toContain("Declined");
	});

	it("skips a foreign template hook without --force, overwrites it with --force", async () => {
		const templateDir = path.join(mkTmp(), "template");
		const hooksDir = path.join(templateDir, "hooks");
		fs.mkdirSync(hooksDir, { recursive: true });
		const foreign = path.join(hooksDir, "post-checkout");
		fs.writeFileSync(foreign, "#!/bin/sh\necho foreign\n");

		const out1 = capture();
		await api.cli.installTemplate.run({ templateDir, yes: true });
		expect(out1.join("\n")).toContain("Skipped post-checkout");
		expect(fs.readFileSync(foreign, "utf8")).toBe("#!/bin/sh\necho foreign\n");
		vi.restoreAllMocks();

		const out2 = capture();
		await api.cli.installTemplate.run({ templateDir, yes: true, force: true });
		expect(fs.readFileSync(foreign, "utf8")).toContain("git-embedded");
		expect(out2.join("\n")).toContain("Installed template hooks");
	});
});

describe("api.cli.printHookScript", () => {
	it("prints the packaged script body verbatim for each known name", () => {
		const cases = [
			["post-checkout", "update-embedded-repos"],
			["post-merge", "update-embedded-repos"],
			["reference-transaction", "reference-transaction"],
			["pre-push", "pre-push"],
			["update-embedded-repos", "update-embedded-repos"],
			["_dispatch", "_dispatch.template"],
			["dispatcher", "_dispatch.template"]
		];
		for (const [name, sourceFile] of cases) {
			const expected = fs.readFileSync(path.join(hooksSrcDir, sourceFile), "utf8");
			const chunks = captureStdoutRaw();
			api.cli.printHookScript.run(name);
			expect(chunks.join("")).toBe(expected);
			vi.restoreAllMocks();
		}
	});

	it("refuses an unknown hook name and exits 2", () => {
		const out = capture();
		mockExit();
		expect(() => api.cli.printHookScript.run("not-a-hook")).toThrow(/process\.exit\(2\)/);
		expect(out.join("\n")).toContain("Unknown hook script: not-a-hook");
	});
});

describe("api.cli.version", () => {
	it("prints the package name+version, node, and platform", () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
		const out = capture();
		api.cli.version.run();
		expect(out[0]).toBe(`${pkg.name} ${pkg.version}`);
		expect(out).toContain(`node ${process.version.replace(/^v/, "")}`);
		expect(out).toContain(`platform ${process.platform}`);
	});
});

describe("api.cli.doctor", () => {
	it("reports 'No hook setup detected' for a plain repo and takes no action", async () => {
		const { repo, gitDir } = makeRepo();
		process.chdir(repo);
		const out = capture();
		await api.cli.doctor.run();
		const text = out.join("\n");
		expect(text).toContain("Detected: No hook setup detected");
		// Doctor is read-only — it must not have installed anything.
		expect(fs.existsSync(path.join(gitDir, "hooks", "post-checkout"))).toBe(false);
	});

	it("classifies a husky repo as a foreign manager", async () => {
		const { repo } = makeRepo();
		plantHusky(repo);
		process.chdir(repo);
		const out = capture();
		await api.cli.doctor.run();
		expect(out.join("\n")).toContain("Detected: Husky");
	});
});

describe("api.cli.init", () => {
	it("runs install-hooks then silences the embedded-repo advice", async () => {
		const { repo, gitDir } = makeRepo();
		process.chdir(repo);
		const out = capture();
		await api.cli.init.run({});
		// install-hooks ran (declined dispatcher → per-repo install).
		assertOwnedHooksInstalled(path.join(gitDir, "hooks"));
		// advice.addEmbeddedRepo was set false in the repo's local config.
		expect(git(["config", "--get", "advice.addEmbeddedRepo"], repo)).toBe("false");
		expect(out.join("\n")).toContain("Silenced 'embedded git repository' advice");
	});
});
