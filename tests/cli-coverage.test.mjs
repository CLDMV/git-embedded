/**
 *	@Project: @cldmv/git-embedded
 *	@Filename: /tests/cli-coverage.test.mjs
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 * Gap-closing behavior tests for the CLI wrapper commands (src/api/cli/*.mjs),
 * driven through the composed slothlet api against REAL temp git repos in the
 * same house style as cli-hooks.test.mjs / cli-provisioning.test.mjs. Each test
 * targets an uncovered path the existing suites do not exercise:
 *
 *   - link:            full command coverage (blocksClone refusals, clone/add
 *                      failures, outside-worktree guards, the non-repo add path).
 *   - install-hooks:   the switch default, the no-gitDir + all-skipped install
 *                      paths, heal/bootstrap copy-fallback, the git-config
 *                      failure, the CancelledByUser + re-throw catch arms, and
 *                      the "no git repo" post-bootstrap branch.
 *   - init:            the git-config failure warn arm.
 *   - export:          the missing-exclude catch, the no-trailing-newline prefix,
 *                      and the non-repo root fallback.
 *   - install-template: the nothing-installed (all-skipped) branch.
 *   - record/restore/sync: the no-branch / no-note LABEL arms and the
 *                      unknown-outcome LABEL fallbacks.
 *
 * Temp git repos live under the repo's own tmp/ (never the system /tmp), and a
 * GIT_CEILING so a non-repo temp dir there is genuinely seen as a non-repo.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getApi } from "./_setup.mjs";
import { CancelledByUser } from "../src/api/link/batch.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
// All scratch git repos live under the repo's tmp/ (gitignored), never /tmp.
const WORK_ROOT = path.join(packageRoot, "tmp", "cli-cov-work");
fs.mkdirSync(WORK_ROOT, { recursive: true });

const PACKAGE_HOOKS = ["post-checkout", "post-merge", "post-rewrite", "reference-transaction", "pre-push"];
const REQUIRED_HOOKS = ["post-checkout", "post-merge", "post-rewrite", "reference-transaction"];

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
function mkTmp(prefix = "wt-") {
	const dir = fs.mkdtempSync(path.join(WORK_ROOT, prefix));
	tmpRoots.push(dir);
	return dir;
}

// Whether this environment can CREATE symlinks (skips the symlink-dependent cases
// on a host that denies creation, e.g. Windows without Developer Mode).
const canSymlink = (() => {
	let dir = null;
	try {
		dir = fs.mkdtempSync(path.join(WORK_ROOT, "symlink-probe-"));
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

/** A bare child repo carrying one commit; returns its path (usable as a clone URL). */
function makeBareWithCommit(marker = "child") {
	const root = mkTmp("child-");
	const bare = path.join(root, "child.git");
	git(["init", "--bare", "-b", "main", bare]);
	const src = path.join(root, "src");
	git(["init", "-b", "main", src]);
	fs.writeFileSync(path.join(src, "spec.txt"), marker);
	git(["add", "."], src);
	git(["commit", "-m", "init"], src);
	git(["remote", "add", "origin", bare], src);
	git(["push", "origin", "main"], src);
	return bare;
}

/** Build a dispatcher dir: a chaining `_dispatch` plus a symlink for each name. */
function makeDispatcherDir(linked) {
	const dir = path.join(mkTmp("disp-"), "hooks");
	fs.mkdirSync(dir, { recursive: true });
	const dispatch = path.join(dir, "_dispatch");
	fs.writeFileSync(dispatch, CHAINING_DISPATCHER);
	fs.chmodSync(dispatch, 0o755);
	for (const name of linked) fs.symlinkSync(dispatch, path.join(dir, name));
	return { dir, dispatch };
}

// ---- child-in-parent fixtures (mirrors cli-provisioning.test.mjs) --------

function makeChildBare(work, remotes, bareName, marker) {
	const bare = path.join(remotes, `${bareName}.git`);
	git(["init", "--bare", "-b", "main", bare]);
	const src = path.join(work, `src-${bareName}`);
	git(["init", "-b", "main", src]);
	fs.writeFileSync(path.join(src, "spec.txt"), marker);
	git(["add", "."], src);
	git(["commit", "-m", `${bareName} init`], src);
	git(["remote", "add", "origin", bare], src);
	git(["push", "origin", "main"], src);
	const sha = git(["rev-parse", "HEAD"], src);
	return { bare, sha };
}

function makeParent({ gitlinkPath = "tests" } = {}) {
	const work = mkTmp("parent-");
	const remotes = path.join(work, "remotes");
	fs.mkdirSync(remotes, { recursive: true });
	const bareName = gitlinkPath.split("/").pop();
	const child = makeChildBare(work, remotes, bareName, "child");

	const parentBare = path.join(remotes, "parent.git");
	git(["init", "--bare", "-b", "main", parentBare]);
	const parentSrc = path.join(work, "src-parent");
	git(["init", "-b", "main", parentSrc]);
	fs.writeFileSync(path.join(parentSrc, "README.md"), "parent");
	git(["add", "."], parentSrc);
	git(["commit", "-m", "parent init"], parentSrc);
	git(["clone", "--quiet", child.bare, path.join(parentSrc, gitlinkPath)]);
	git(["add", gitlinkPath], parentSrc);
	git(["commit", "-m", `embed ${gitlinkPath}`], parentSrc);
	git(["remote", "add", "origin", parentBare], parentSrc);
	git(["push", "origin", "main"], parentSrc);

	return { work, remotes, parentBare, childBare: child.bare, childSha: child.sha, gitlinkPath };
}

function freshClone(parentBare) {
	const dir = path.join(mkTmp("clone-"), "clone");
	git(["clone", "--quiet", parentBare, dir]);
	return dir;
}

function advanceChild(work, bareName, marker, { push = true } = {}) {
	const src = path.join(work, `src-${bareName}`);
	fs.writeFileSync(path.join(src, "next.txt"), marker);
	git(["add", "."], src);
	git(["commit", "-m", `${bareName} advance`], src);
	if (push) git(["push", "origin", "main"], src);
	return git(["rev-parse", "HEAD"], src);
}

function bumpPin(parentDir, childPath, sha) {
	git(["update-index", "--cacheinfo", `160000,${sha},${childPath}`], parentDir);
	git(["commit", "-m", `bump ${childPath} pin`], parentDir);
}

// ---- output + process.exit capture ---------------------------------------

let logLines;
let errLines;
let stdoutChunks;
let readonlyDirs; // dirs chmod'd unreadable in a test; restored before cleanup

const stripAnsi = (s) => String(s).replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"), "");
const logText = () => logLines.map(stripAnsi).join("\n");
const errText = () => errLines.map(stripAnsi).join("\n");
const outText = () => stdoutChunks.map(stripAnsi).join("");

function resetOutput() {
	logLines.length = 0;
	errLines.length = 0;
	stdoutChunks.length = 0;
}

/**
 * Run a sync CLI wrapper (link/restore/record/export/sync). These end with
 * process.exit(code) (mocked to throw) on some paths; translate that back into
 * the returned exit code. A path that returns normally yields null. A non-exit
 * throw (a real error) propagates.
 */
function runCli(fn) {
	try {
		fn();
	} catch (err) {
		const m = /process\.exit\((-?\d+)\)/.exec(String(err && err.message));
		if (!m) throw err;
		return Number(m[1]);
	}
	return null;
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
	// A non-repo temp dir under the repo's tmp/ must NOT resolve up to the
	// enclosing worktree — stop git's discovery at the work root.
	process.env.GIT_CEILING_DIRECTORIES = WORK_ROOT;
	// Redirect XDG so the transaction log + default dispatcher dir land in temp.
	process.env.XDG_STATE_HOME = mkTmp("state-");
	process.env.XDG_CONFIG_HOME = mkTmp("config-");

	logLines = [];
	errLines = [];
	stdoutChunks = [];
	readonlyDirs = [];
	vi.spyOn(console, "log").mockImplementation((...a) => logLines.push(a.map(String).join(" ")));
	vi.spyOn(console, "error").mockImplementation((...a) => errLines.push(a.map(String).join(" ")));
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		stdoutChunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
		return true;
	});
	vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new Error(`process.exit(${code})`);
	});
});

afterEach(() => {
	try {
		process.chdir(originalCwd);
	} catch {
		// ignore
	}
	for (const d of readonlyDirs) {
		try {
			fs.chmodSync(d, 0o755);
		} catch {
			// ignore
		}
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

// ==========================================================================
// link
// ==========================================================================
describe("api.cli.link.run", () => {
	it("clones a missing target, stages the gitlink, and records the URL", () => {
		const { repo } = makeRepo();
		const bare = makeBareWithCommit();
		process.chdir(repo);

		api.cli.link.run("tests", bare); // happy path: no process.exit

		expect(logText()).toContain(`Cloning ${bare} into tests`);
		expect(logText()).toContain("Staged gitlink at tests");
		expect(fs.existsSync(path.join(repo, "tests", ".git"))).toBe(true);
		// Staged as a gitlink (mode 160000) and recorded in the local registry.
		expect(git(["ls-files", "--stage", "tests"], repo)).toMatch(/^160000 /);
		expect(api.embedded.registry.getUrl("tests", repo)).toBe(bare);
	});

	it("clones into a pre-existing EMPTY directory (an accepted target)", () => {
		const { repo } = makeRepo();
		const bare = makeBareWithCommit();
		fs.mkdirSync(path.join(repo, "empty"));
		process.chdir(repo);

		api.cli.link.run("empty", bare);
		expect(fs.existsSync(path.join(repo, "empty", ".git"))).toBe(true);
	});

	it("refuses a non-empty directory target and exits 2", () => {
		const { repo } = makeRepo();
		const bare = makeBareWithCommit();
		fs.mkdirSync(path.join(repo, "busy"));
		fs.writeFileSync(path.join(repo, "busy", "f"), "x");
		process.chdir(repo);

		const code = runCli(() => api.cli.link.run("busy", bare));
		expect(code).toBe(2);
		expect(errText()).toContain("busy exists and is not an empty directory");
	});

	it("refuses a plain-file target and exits 2", () => {
		const { repo } = makeRepo();
		const bare = makeBareWithCommit();
		fs.writeFileSync(path.join(repo, "afile"), "x");
		process.chdir(repo);

		const code = runCli(() => api.cli.link.run("afile", bare));
		expect(code).toBe(2);
		expect(errText()).toContain("afile exists and is not an empty directory");
	});

	it.skipIf(!canSymlink)("refuses a symlink target and exits 2", () => {
		const { repo } = makeRepo();
		const bare = makeBareWithCommit();
		fs.symlinkSync(mkTmp("linktgt-"), path.join(repo, "alink"), "dir");
		process.chdir(repo);

		const code = runCli(() => api.cli.link.run("alink", bare));
		expect(code).toBe(2);
		expect(errText()).toContain("alink exists and is not an empty directory");
	});

	it("refuses an unreadable directory target and exits 2 (readdir throws)", () => {
		const { repo } = makeRepo();
		const bare = makeBareWithCommit();
		const noread = path.join(repo, "noread");
		fs.mkdirSync(noread);
		fs.chmodSync(noread, 0o000);
		readonlyDirs.push(noread);
		process.chdir(repo);

		const code = runCli(() => api.cli.link.run("noread", bare));
		expect(code).toBe(2);
		expect(errText()).toContain("noread exists and is not an empty directory");
	});

	it("refuses a target outside the worktree ('..') and exits 2", () => {
		const { repo } = makeRepo();
		const bare = makeBareWithCommit();
		process.chdir(repo);

		const code = runCli(() => api.cli.link.run("../outside", bare));
		expect(code).toBe(2);
		expect(errText()).toContain("outside the repository worktree");
	});

	it("refuses the repo root itself ('.') and exits 2", () => {
		const { repo } = makeRepo();
		const bare = makeBareWithCommit();
		process.chdir(repo);

		const code = runCli(() => api.cli.link.run(".", bare));
		expect(code).toBe(2);
		expect(errText()).toContain("outside the repository worktree");
	});

	it("exits with git's status when the clone fails", () => {
		const { repo } = makeRepo();
		process.chdir(repo);
		const nonexistent = path.join(mkTmp("bad-"), "does-not-exist.git");

		const code = runCli(() => api.cli.link.run("newchild", nonexistent));
		expect(code).toBe(128); // git clone of a missing repo exits 128
		expect(errText()).toContain("git clone exited with status 128");
		expect(fs.existsSync(path.join(repo, "newchild", ".git"))).toBe(false);
	});

	it("outside a repo: root falls back to cwd and the git add fails", () => {
		// getRepoRoot() is null here (ceiling stops discovery), so root=cwd; the
		// clone still succeeds (it makes its own repo) but the follow-up git add
		// has no parent repo to stage into.
		const nonrepo = mkTmp("nonrepo-");
		const bare = makeBareWithCommit();
		process.chdir(nonrepo);

		const code = runCli(() => api.cli.link.run("child", bare));
		expect(code).toBe(128);
		expect(errText()).toContain("git add child exited with status 128");
		// The clone itself happened (proves we got past the clone step).
		expect(fs.existsSync(path.join(nonrepo, "child", ".git"))).toBe(true);
	});
});

// ==========================================================================
// install-hooks
// ==========================================================================
describe("api.cli.installHooks — uncovered action/branch paths", () => {
	it("refuses an unknown detection action and exits 2", async () => {
		const { repo } = makeRepo();
		process.chdir(repo);
		vi.spyOn(api.detect, "run").mockReturnValue({
			action: "totally-bogus",
			kind: "none",
			paths: {},
			signals: { hooksPathScopes: { system: null, global: null, local: null }, initTemplateDir: null }
		});

		await expect(api.cli.installHooks.run({})).rejects.toThrow(/process\.exit\(2\)/);
		expect(errText()).toContain("Unknown detection action: totally-bogus");
	});

	it.skipIf(!canSymlink)("install action outside a git repo: refuses (no gitDir) and exits 2", async () => {
		const { dir } = makeDispatcherDir(REQUIRED_HOOKS); // canonical-complete
		const globalCfg = path.join(mkTmp("gcfg-"), "gitconfig");
		process.env.GIT_CONFIG_GLOBAL = globalCfg;
		git(["config", "--global", "core.hooksPath", dir], undefined);
		process.chdir(mkTmp("nonrepo-")); // canonical dispatcher is global, but no repo here

		await expect(api.cli.installHooks.run({})).rejects.toThrow(/process\.exit\(2\)/);
		expect(errText()).toContain("Not inside a git repository");
	});

	it.skipIf(!canSymlink)("install action with all hooks foreign installs nothing (no success line)", async () => {
		const { dir } = makeDispatcherDir(REQUIRED_HOOKS);
		const { repo, gitDir } = makeRepo();
		const hooksDir = path.join(gitDir, "hooks");
		fs.mkdirSync(hooksDir, { recursive: true });
		for (const name of PACKAGE_HOOKS) fs.writeFileSync(path.join(hooksDir, name), "#!/bin/sh\necho foreign\n");
		git(["config", "--local", "core.hooksPath", dir], repo);
		process.chdir(repo);

		await api.cli.installHooks.run({});
		expect(logText()).not.toContain("Installed per-repo hooks");
		for (const name of PACKAGE_HOOKS) expect(logText()).toContain(`Skipped ${name}`);
	});

	it.skipIf(!canSymlink)("heal-then-install: warns on a filesystem copy fallback", async () => {
		// A required entry that already exists as a PLAIN FILE is classified
		// missing; healing it hits EEXIST on the symlink and falls back to copy.
		const dir = path.join(mkTmp("disp-"), "hooks");
		fs.mkdirSync(dir, { recursive: true });
		const dispatch = path.join(dir, "_dispatch");
		fs.writeFileSync(dispatch, CHAINING_DISPATCHER);
		fs.chmodSync(dispatch, 0o755);
		fs.symlinkSync(dispatch, path.join(dir, "post-checkout"));
		fs.symlinkSync(dispatch, path.join(dir, "post-merge"));
		fs.writeFileSync(path.join(dir, "post-rewrite"), "#!/bin/sh\necho stale\n"); // plain file → missing
		// reference-transaction absent → healed as a fresh symlink

		const { repo } = makeRepo();
		git(["config", "--local", "core.hooksPath", dir], repo);
		process.chdir(repo);

		await api.cli.installHooks.run({ yes: true });
		expect(logText()).toMatch(/Healed \d+ entries/);
		expect(logText()).toContain("Filesystem fallback to copy for 1 entries");
	});

	it.skipIf(!canSymlink)("heal-then-install: CancelledByUser aborts with exit 2", async () => {
		const { dir } = makeDispatcherDir(["post-checkout", "post-merge"]); // missing two required
		const { repo } = makeRepo();
		git(["config", "--local", "core.hooksPath", dir], repo);
		process.chdir(repo);
		vi.spyOn(api.install, "dispatcher").mockImplementation(() => {
			throw new CancelledByUser("symlink batch cancelled");
		});

		await expect(api.cli.installHooks.run({ yes: true, noSymlinks: true })).rejects.toThrow(/process\.exit\(2\)/);
		expect(errText()).toContain("symlink batch cancelled");
		expect(logText()).toContain("re-run with --no-symlinks");
	});

	it.skipIf(!canSymlink)("heal-then-install: a non-cancel error propagates (re-thrown)", async () => {
		const { dir } = makeDispatcherDir(["post-checkout", "post-merge"]);
		const { repo } = makeRepo();
		git(["config", "--local", "core.hooksPath", dir], repo);
		process.chdir(repo);
		vi.spyOn(api.install, "dispatcher").mockImplementation(() => {
			throw new Error("heal-boom");
		});

		await expect(api.cli.installHooks.run({ yes: true })).rejects.toThrow(/heal-boom/);
	});

	it.skipIf(!canSymlink)("bootstrap: reports git-config failure and exits 1", async () => {
		const { repo } = makeRepo();
		const dispatcherDir = path.join(mkTmp("disp-"), "global-hooks");
		// GIT_CONFIG_GLOBAL under a missing parent dir → `git config --global` fails.
		process.env.GIT_CONFIG_GLOBAL = path.join(mkTmp("nogdir-"), "no-such-dir", "gitconfig");
		process.chdir(repo);

		await expect(api.cli.installHooks.run({ yes: true, dispatcherDir })).rejects.toThrow(/process\.exit\(1\)/);
		expect(errText()).toContain("git config --global core.hooksPath failed");
	});

	it("bootstrap: CancelledByUser aborts with exit 2", async () => {
		const { repo } = makeRepo();
		const dispatcherDir = path.join(mkTmp("disp-"), "global-hooks");
		process.chdir(repo);
		vi.spyOn(api.install, "dispatcher").mockImplementation(() => {
			throw new CancelledByUser("bootstrap cancelled");
		});

		await expect(api.cli.installHooks.run({ yes: true, noSymlinks: true, dispatcherDir })).rejects.toThrow(/process\.exit\(2\)/);
		expect(errText()).toContain("bootstrap cancelled");
		expect(logText()).toContain("re-run with --no-symlinks");
	});

	it("bootstrap: a non-cancel error propagates (re-thrown)", async () => {
		const { repo } = makeRepo();
		const dispatcherDir = path.join(mkTmp("disp-"), "global-hooks");
		process.chdir(repo);
		vi.spyOn(api.install, "dispatcher").mockImplementation(() => {
			throw new Error("bootstrap-boom");
		});

		await expect(api.cli.installHooks.run({ yes: true, dispatcherDir })).rejects.toThrow(/bootstrap-boom/);
	});

	it("bootstrap: warns on a filesystem copy fallback, then sets global config", async () => {
		const { repo } = makeRepo();
		const dispatcherDir = path.join(mkTmp("disp-"), "global-hooks");
		const globalCfg = path.join(mkTmp("gcfg-"), "gitconfig");
		process.env.GIT_CONFIG_GLOBAL = globalCfg; // writable → git config succeeds
		process.chdir(repo);
		vi.spyOn(api.install, "dispatcher").mockReturnValue({
			dispatcherPath: path.join(dispatcherDir, "_dispatch"),
			created: [{ source: path.join(dispatcherDir, "post-commit"), mechanism: "copy" }],
			fallbackToCopy: [path.join(dispatcherDir, "post-commit")]
		});

		await api.cli.installHooks.run({ yes: true, dispatcherDir });
		expect(logText()).toContain("Filesystem fallback to copy for 1 entries");
		expect(logText()).toContain(`Set git config --global core.hooksPath ${dispatcherDir}`);
	});

	it("suggest-dispatcher declined outside a repo: installs nothing and returns", async () => {
		process.chdir(mkTmp("nonrepo-")); // non-TTY → declined, and no gitDir to fall back to
		await api.cli.installHooks.run({});
		expect(logText()).toContain("Dispatcher install declined");
		expect(logText()).not.toContain("Installed per-repo hooks");
	});

	it.skipIf(!canSymlink)("bootstrap --yes outside a repo: warns it skipped per-repo install", async () => {
		const dispatcherDir = path.join(mkTmp("disp-"), "global-hooks");
		const globalCfg = path.join(mkTmp("gcfg-"), "gitconfig");
		process.env.GIT_CONFIG_GLOBAL = globalCfg;
		process.chdir(mkTmp("nonrepo-"));

		await api.cli.installHooks.run({ yes: true, dispatcherDir });
		expect(logText()).toContain("Dispatcher installed at");
		expect(logText()).toContain("Not inside a git repo — skipping per-repo hook install.");
	});
});

// ==========================================================================
// init
// ==========================================================================
describe("api.cli.init.run", () => {
	it("warns when the advice git-config write fails (outside a repo)", async () => {
		// install-hooks declines the dispatcher (non-TTY, no gitDir) and returns;
		// then `git config advice.addEmbeddedRepo false` fails (not in a repo).
		process.chdir(mkTmp("nonrepo-"));
		await api.cli.init.run({});
		expect(logText()).toContain("Could not set git config advice.addEmbeddedRepo");
	});
});

// ==========================================================================
// export
// ==========================================================================
describe("api.cli.export.run — uncovered paths", () => {
	it("adds to a missing .git/info/exclude (readFile catch)", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		process.chdir(fresh);
		runCli(() => api.cli.restore.run([], {}));
		fs.rmSync(path.join(fresh, ".git", "info", "exclude"), { force: true });
		resetOutput();

		runCli(() => api.cli.export.run({ o: "children.json" }));
		expect(logText()).toContain("added children.json to .git/info/exclude");
		expect(fs.readFileSync(path.join(fresh, ".git", "info", "exclude"), "utf8")).toContain("children.json");
	});

	it("prepends a newline when the existing exclude has no trailing newline", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		process.chdir(fresh);
		runCli(() => api.cli.restore.run([], {}));
		const excludeFile = path.join(fresh, ".git", "info", "exclude");
		fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
		fs.writeFileSync(excludeFile, "existing-pattern"); // NO trailing newline
		resetOutput();

		runCli(() => api.cli.export.run({ o: "children.json" }));
		expect(fs.readFileSync(excludeFile, "utf8")).toBe("existing-pattern\nchildren.json\n");
	});

	it("outside a repo: root falls back to cwd and an empty manifest goes to stdout", () => {
		process.chdir(mkTmp("nonrepo-"));
		const code = runCli(() => api.cli.export.run({}));
		expect(code).toBeNull();
		const parsed = JSON.parse(outText());
		expect(parsed.version).toBe(1);
		expect(parsed.children).toEqual({});
	});
});

// ==========================================================================
// install-template
// ==========================================================================
describe("api.cli.installTemplate.run", () => {
	it("installs nothing (no success line) when every template hook is foreign", async () => {
		const templateDir = path.join(mkTmp("tmpl-"), "template");
		const hooksDir = path.join(templateDir, "hooks");
		fs.mkdirSync(hooksDir, { recursive: true });
		for (const name of PACKAGE_HOOKS) fs.writeFileSync(path.join(hooksDir, name), "#!/bin/sh\necho foreign\n");

		await api.cli.installTemplate.run({ templateDir, yes: true });
		expect(logText()).not.toContain("Installed template hooks");
		for (const name of PACKAGE_HOOKS) expect(logText()).toContain(`Skipped ${name}`);
	});
});

// ==========================================================================
// record
// ==========================================================================
describe("api.cli.record.run — uncovered LABEL arms", () => {
	it("records a detached child with no branch suffix", () => {
		const { parentBare, childBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		process.chdir(fresh);
		runCli(() => api.cli.restore.run([], {}));
		git(["checkout", "--detach"], path.join(fresh, "tests")); // detached → no current branch
		resetOutput();

		runCli(() => api.cli.record.run([]));
		const line = logText()
			.split("\n")
			.find((l) => l.includes("tests →"));
		expect(line).toContain(`tests → ${childBare}`);
		expect(line).not.toContain("("); // no "(branch)" suffix when detached
	});

	it("renders an unknown outcome through the LABEL fallback", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		process.chdir(fresh);
		vi.spyOn(api.embedded, "record").mockReturnValue({ results: [{ path: "weirdo", outcome: "surprise" }] });

		runCli(() => api.cli.record.run([]));
		expect(logText()).toContain("weirdo: surprise");
	});
});

// ==========================================================================
// restore
// ==========================================================================
describe("api.cli.restore.run — uncovered LABEL arms", () => {
	it("renders note-less unresolved/pinned-mismatch and the unknown-outcome fallback", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		process.chdir(fresh);
		vi.spyOn(api.embedded, "restore").mockReturnValue({
			results: [
				{ path: "a", outcome: "unresolved", note: null },
				{ path: "b", outcome: "pinned-mismatch", note: null },
				{ path: "c", outcome: "mystery" }
			],
			exitCode: 1
		});

		const code = runCli(() => api.cli.restore.run([], {}));
		expect(code).toBe(1);
		expect(errText()).toContain("a unresolved");
		expect(errText()).toContain("b pinned-mismatch");
		expect(logText()).toContain("c: mystery");
		// The note-less arms print no " — " detail.
		expect(errText()).not.toContain("a unresolved —");
		expect(errText()).not.toContain("b pinned-mismatch —");
	});
});

// ==========================================================================
// sync
// ==========================================================================
describe("api.cli.sync.run — uncovered outcome/LABEL arms", () => {
	it("leaves an 'ahead' child alone (commits beyond the pin)", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		process.chdir(fresh);
		runCli(() => api.cli.restore.run([], {}));
		// Advance the CHILD's registered branch past the pin (do not move the pin).
		const child = path.join(fresh, "tests");
		fs.writeFileSync(path.join(child, "ahead.txt"), "ahead");
		git(["add", "."], child);
		git(["commit", "-m", "child ahead"], child);
		resetOutput();

		const code = runCli(() => api.cli.sync.run([], {}));
		expect(code).toBe(0);
		expect(logText()).toContain("commits beyond the pin");
		expect(logText()).toContain("0 synced, 0 unchanged, 1 left alone, 0 failed.");
	});

	it("leaves an unregistered-branch child alone", () => {
		const { work, parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		process.chdir(fresh);
		runCli(() => api.cli.restore.run([], {})); // registers branch main
		const sha2 = advanceChild(work, "tests", "v2");
		bumpPin(fresh, "tests", sha2);
		git(["checkout", "-b", "feature"], path.join(fresh, "tests")); // now on an unregistered branch
		resetOutput();

		const code = runCli(() => api.cli.sync.run([], {}));
		expect(code).toBe(0);
		expect(logText()).toContain("unregistered branch 'feature'");
		expect(logText()).toContain("1 left alone");
	});

	it.skipIf(!canSymlink)("reports sync-failed for a symlinked gitlink path and exits 1", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		process.chdir(fresh);
		runCli(() => api.cli.restore.run([], {}));
		const child = path.join(fresh, "tests");
		fs.rmSync(child, { recursive: true, force: true });
		fs.symlinkSync(mkTmp("linktgt-"), child, "dir"); // gitlink path is now a symlink
		resetOutput();

		const code = runCli(() => api.cli.sync.run([], {}));
		expect(code).toBe(1);
		expect(errText()).toContain("tests sync-failed");
		expect(errText()).toContain("symbolic link");
	});

	it("snaps a detached child to the moved pin (detached synced)", () => {
		const { work, parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		process.chdir(fresh);
		runCli(() => api.cli.restore.run([], {}));
		const sha2 = advanceChild(work, "tests", "v2");
		bumpPin(fresh, "tests", sha2);
		git(["checkout", "--detach"], path.join(fresh, "tests")); // detached at old pin
		resetOutput();

		const code = runCli(() => api.cli.sync.run([], {}));
		expect(code).toBe(0);
		expect(logText()).toContain("synced tests");
		expect(logText()).toContain("(detached)");
		expect(git(["rev-parse", "HEAD"], path.join(fresh, "tests"))).toBe(sha2);
	});

	it("renders note-less pin-unavailable/sync-failed and the unknown-outcome fallback", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		process.chdir(fresh);
		vi.spyOn(api.embedded, "sync").mockReturnValue({
			results: [
				{ path: "a", outcome: "pin-unavailable", note: null },
				{ path: "b", outcome: "sync-failed", note: null },
				{ path: "c", outcome: "mystery" }
			],
			exitCode: 1
		});

		const code = runCli(() => api.cli.sync.run([], {}));
		expect(code).toBe(1);
		expect(errText()).toContain("a pin-unavailable");
		expect(errText()).toContain("b sync-failed");
		expect(logText()).toContain("c: mystery");
		expect(errText()).not.toContain("a pin-unavailable —");
		expect(errText()).not.toContain("b sync-failed —");
	});
});
