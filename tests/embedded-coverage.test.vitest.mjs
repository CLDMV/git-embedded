/**
 * Coverage closure for the embedded engine. These target the error/edge/defensive
 * branches that embedded-provisioning.test.vitest.mjs and embedded-topup.test.vitest.mjs leave
 * uncovered, against REAL temp git fixtures (house style — no over-mocking):
 *
 *   - branch.mjs / gitlinks.mjs / registry.mjs — the `res.status ?? 1` spawn-failure
 *     fallback (git absent from PATH → null status), plus registry.entries()'s
 *     multi-line-config parse guards.
 *   - manifest.mjs  — relative-path resolution, the missing-file null return, the
 *     invalid-JSON throw, and build()'s null/url-less entry drops.
 *   - resolve.mjs   — conventionUrl basename of an empty path segment.
 *   - restore.mjs   — paths-filter miss, non-ENOENT lstat (ENOTDIR/EACCES) refusals,
 *     the "nothing resolves" unresolved, and the attach-fail → detached fallback.
 *   - sync.mjs      — non-repo cwd, skip, paths-filter miss, symlink-parent ENOTDIR,
 *     detached dry-run, the corrupt-ancestry sync-failed, and index-locked branch /
 *     detached checkout failures.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getApi } from "./_setup.mjs";

// Scratch git fixtures live under the repo's gitignored tmp/ (never the system
// /tmp), and are torn down per-test in afterEach. Because tmp/ sits INSIDE this
// repo's worktree, a fixture that isn't itself a git repo would otherwise resolve
// the enclosing repo as its root; GIT_CEILING_DIRECTORIES (set in beforeEach)
// stops git's upward search at repoTmp so a non-repo fixture reads as non-repo,
// exactly as an out-of-tree /tmp fixture would.
const repoTmp = (() => {
	const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "tmp");
	fs.mkdirSync(p, { recursive: true });
	return fs.realpathSync(p);
})();

const tmpRoots = [];

function mkTmp() {
	const dir = fs.mkdtempSync(path.join(repoTmp, "git-embedded-cov-"));
	tmpRoots.push(dir);
	return dir;
}

/** Throwing git for fixture setup. */
function git(args, cwd) {
	const res = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (res.status !== 0) throw new Error(`git ${args.join(" ")} (cwd=${cwd}) failed: ${res.stderr || res.stdout}`);
	return (res.stdout || "").trim();
}

const BOGUS_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

// Whether emptying PATH makes a bare `git` unresolvable (spawnSync → null status).
// True on POSIX; the coverage runner is Linux. Guards the spawn-failure tests so
// they don't misfire on a platform that still resolves git.exe without PATH.
const gitVanishesWithoutPath = (() => {
	const saved = process.env.PATH;
	try {
		process.env.PATH = "";
		return spawnSync("git", ["--version"], { encoding: "utf8" }).status === null;
	} catch {
		return false;
	} finally {
		process.env.PATH = saved;
	}
})();

/** Run `fn` with an emptied PATH so every git spawn yields a null status. */
function withBrokenPath(fn) {
	const saved = process.env.PATH;
	process.env.PATH = "";
	try {
		return fn();
	} finally {
		process.env.PATH = saved;
	}
}

/**
 * Bare "child source" repo with one commit on `main` (pushed), under
 * `remotes/<bareName>.git`. Returns the bare path + pinned SHA.
 */
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
	return { bare, sha: git(["rev-parse", "HEAD"], src) };
}

/**
 * Parent repo carrying an anonymous gitlink at `gitlinkPath`, pushed to a bare.
 * `childBareName` obscures the child (defaults to the gitlink basename so
 * convention resolves).
 */
function makeParent({ childBareName = null, gitlinkPath = "tests", pinMarker = "child" } = {}) {
	const work = mkTmp();
	const remotes = path.join(work, "remotes");
	fs.mkdirSync(remotes, { recursive: true });

	const bareName = childBareName || gitlinkPath.split("/").pop();
	const child = makeChildBare(work, remotes, bareName, pinMarker);

	const parentBare = path.join(remotes, "parent.git");
	git(["init", "--bare", "-b", "main", parentBare]);
	const parentSrc = path.join(work, "src-parent");
	git(["init", "-b", "main", parentSrc]);
	fs.writeFileSync(path.join(parentSrc, "README.md"), "parent");
	git(["add", "."], parentSrc);
	git(["commit", "-m", "parent init"], parentSrc);
	// Materialize intermediate dirs for a nested gitlink path.
	fs.mkdirSync(path.dirname(path.join(parentSrc, gitlinkPath)), { recursive: true });
	git(["clone", "--quiet", child.bare, path.join(parentSrc, gitlinkPath)]);
	git(["add", gitlinkPath], parentSrc);
	git(["commit", "-m", `embed ${gitlinkPath}`], parentSrc);
	git(["remote", "add", "origin", parentBare], parentSrc);
	git(["push", "origin", "main"], parentSrc);

	return { work, remotes, parentBare, childBare: child.bare, childSha: child.sha, bareName, gitlinkPath };
}

function freshClone(parentBare) {
	const dir = path.join(mkTmp(), "clone");
	git(["clone", "--quiet", parentBare, dir]);
	return dir;
}

/** Advance the child source by one commit (pushed by default). Returns new SHA. */
function advanceChild(work, bareName, marker, { push = true } = {}) {
	const src = path.join(work, `src-${bareName}`);
	fs.writeFileSync(path.join(src, `${marker}.txt`), marker);
	git(["add", "."], src);
	git(["commit", "-m", `${bareName} ${marker}`], src);
	if (push) git(["push", "origin", "main"], src);
	return git(["rev-parse", "HEAD"], src);
}

/** Move the parent's gitlink pin to `sha` without touching the child on disk. */
function bumpPin(parentDir, childPath, sha) {
	git(["update-index", "--cacheinfo", `160000,${sha},${childPath}`], parentDir);
	git(["commit", "-m", `bump ${childPath} pin`], parentDir);
}

let originalEnv;
let originalCwd;

beforeEach(() => {
	originalEnv = { ...process.env };
	originalCwd = process.cwd();
	process.env.GIT_CONFIG_GLOBAL = os.platform() === "win32" ? "NUL" : "/dev/null";
	process.env.GIT_CONFIG_SYSTEM = os.platform() === "win32" ? "NUL" : "/dev/null";
	// Keep git from walking out of a non-repo fixture into this enclosing repo.
	process.env.GIT_CEILING_DIRECTORIES = repoTmp;
	process.env.GIT_AUTHOR_NAME = "test";
	process.env.GIT_AUTHOR_EMAIL = "test@example.com";
	process.env.GIT_COMMITTER_NAME = "test";
	process.env.GIT_COMMITTER_EMAIL = "test@example.com";
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
			// Restore perms first — an EACCES-refusal test may have chmod 000'd a dir,
			// which would otherwise block recursive removal.
			try {
				fs.chmodSync(d, 0o755);
			} catch {
				/* ignore */
			}
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

// ─── branch.mjs / gitlinks.mjs / registry.mjs — spawn-failure fallback ──────────

describe("spawn-failure fallback (git absent from PATH → null status)", () => {
	it.skipIf(!gitVanishesWithoutPath)("branch.infer returns null when git cannot be spawned", () => {
		const { work } = makeParent({ gitlinkPath: "tests" });
		const child = path.join(work, "src-tests");
		withBrokenPath(() => {
			expect(api.embedded.branch.infer(child, BOGUS_SHA)).toBeNull();
		});
	});

	it.skipIf(!gitVanishesWithoutPath)("gitlinks returns [] when git cannot be spawned", () => {
		const { work } = makeParent({ gitlinkPath: "tests" });
		withBrokenPath(() => {
			expect(api.embedded.gitlinks(path.join(work, "src-parent"))).toEqual([]);
		});
	});

	it.skipIf(!gitVanishesWithoutPath)("registry.getUrl returns null when git cannot be spawned", () => {
		const { work } = makeParent({ gitlinkPath: "tests" });
		withBrokenPath(() => {
			expect(api.embedded.registry.getUrl("tests", path.join(work, "src-parent"))).toBeNull();
		});
	});

	it.skipIf(!gitVanishesWithoutPath)("restore is a clean no-op when git cannot be spawned", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		const out = withBrokenPath(() => api.embedded.restore({ cwd: fresh }));
		expect(out).toEqual({ results: [], exitCode: 0 });
	});
});

// ─── registry.mjs — entries() parse guards for pathological config output ───────

describe("registry.entries parse guards (multi-line config values)", () => {
	it("skips blank, space-less, and dot-less continuation lines without crashing", () => {
		const root = mkTmp();
		git(["init", "-b", "main", root]);
		// A url value whose text spans lines: `git config --get-regexp` emits it as a
		// key line followed by raw continuation lines — a blank line (L74), a line
		// with no space (L76), and a line whose first token has no dot (L84). The
		// parser must skip all three and still return the well-formed entries.
		api.embedded.registry.setUrl("alpha", "first line\n\nnospace\nhas space", root);
		api.embedded.registry.setUrl("beta", "clean", root);

		const byPath = Object.fromEntries(api.embedded.registry.entries(root).map((e) => [e.path, e]));
		expect(byPath.alpha).toEqual({ path: "alpha", url: "first line" });
		expect(byPath.beta).toEqual({ path: "beta", url: "clean" });
	});
});

// ─── manifest.mjs ───────────────────────────────────────────────────────────────

describe("manifest.read edges", () => {
	it("resolves a RELATIVE file against cwd and returns null when it is missing", () => {
		const dir = mkTmp();
		expect(api.embedded.manifest.read("does-not-exist.json", dir)).toBeNull();
	});

	it("throws a descriptive error for a file that exists but is not valid JSON", () => {
		const dir = mkTmp();
		const bad = path.join(dir, "bad.json");
		fs.writeFileSync(bad, "{ this is not json ");
		expect(() => api.embedded.manifest.read(bad)).toThrow(/is not valid JSON/);
	});
});

describe("manifest.build entry filtering", () => {
	it("returns an empty children map for no entries at all", () => {
		expect(api.embedded.manifest.build()).toEqual({ version: 1, children: {} });
		expect(api.embedded.manifest.build(null)).toEqual({ version: 1, children: {} });
	});

	it("drops null and url-less entries, keeping only entries with a url", () => {
		const manifest = api.embedded.manifest.build([
			null,
			{ path: "no-url" },
			{ path: "keep", url: "ssh://h/keep.git", branch: "main" }
		]);
		expect(Object.keys(manifest.children)).toEqual(["keep"]);
		expect(manifest.children.keep).toEqual({ url: "ssh://h/keep.git", branch: "main" });
	});
});

// ─── resolve.mjs ─────────────────────────────────────────────────────────────────

describe("resolve.conventionUrl basename edge", () => {
	it("yields an empty basename for a path that is only slashes", () => {
		// childPath "" → split/filter → [] → basename falls back to String(childPath).
		expect(api.embedded.resolve.conventionUrl("https://h/o/parent.git", "")).toBe("https://h/o/.git");
	});
});

// ─── restore.mjs ─────────────────────────────────────────────────────────────────

describe("restore edge branches", () => {
	it("skips a gitlink not named by the paths filter (no results)", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		const { results, exitCode } = api.embedded.restore({ cwd: fresh, paths: ["not-a-real-path"] });
		expect(results).toEqual([]);
		expect(exitCode).toBe(0);
		expect(fs.existsSync(path.join(fresh, "tests", ".git"))).toBe(false);
	});

	it("refuses a target whose parent path is a file (non-ENOENT lstat → ENOTDIR)", () => {
		const { parentBare } = makeParent({ gitlinkPath: "vendor/lib" });
		const fresh = freshClone(parentBare);
		// Replace the intermediate `vendor` directory with a regular file so
		// lstat("vendor/lib") fails ENOTDIR — a non-ENOENT error that must be refused,
		// not treated as "absent, clone will create it".
		fs.rmSync(path.join(fresh, "vendor"), { recursive: true, force: true });
		fs.writeFileSync(path.join(fresh, "vendor"), "not a directory");

		const { results, exitCode } = api.embedded.restore({ cwd: fresh });
		expect(results).toHaveLength(1);
		expect(results[0].path).toBe("vendor/lib");
		expect(results[0].outcome).toBe("unresolved");
		expect(results[0].note).toMatch(/target unreadable \(ENOTDIR\).*refusing/);
		expect(exitCode).toBe(1);
		expect(fs.readFileSync(path.join(fresh, "vendor"), "utf8")).toBe("not a directory");
	});

	it("refuses an unreadable (EACCES) materialized gitlink directory", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		const target = path.join(fresh, "tests");
		// A directory git can lstat but the process cannot readdir → the emptiness
		// probe throws EACCES and restore refuses rather than cloning into it.
		fs.chmodSync(target, 0o000);
		try {
			const { results, exitCode } = api.embedded.restore({ cwd: fresh });
			expect(results[0].outcome).toBe("unresolved");
			expect(results[0].note).toMatch(/target unreadable \(EACCES\).*refusing/);
			expect(exitCode).toBe(1);
			expect(fs.existsSync(path.join(target, ".git"))).toBe(false);
		} finally {
			fs.chmodSync(target, 0o755);
		}
	});

	it("reports unresolved when NO source can supply a URL (no origin, config, manifest, or base)", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		// Drop the parent's origin so convention has nothing to derive from, and no
		// registry/manifest/base is supplied → resolve returns a null url.
		git(["remote", "remove", "origin"], fresh);
		const { results, exitCode } = api.embedded.restore({ cwd: fresh });
		expect(results).toHaveLength(1);
		expect(results[0].url).toBeNull();
		expect(results[0].source).toBeNull();
		expect(results[0].outcome).toBe("unresolved");
		expect(results[0].note).toMatch(/no URL from local config, manifest, --base, or convention/);
		expect(exitCode).toBe(1);
	});

	it("deletes the whole clone on a pinned-mismatch when the target did not pre-exist", () => {
		// Decoy at the convention target (tests.git) with unrelated history; the REAL
		// pin lives in a differently-named bare convention never finds.
		const work = mkTmp();
		const remotes = path.join(work, "remotes");
		fs.mkdirSync(remotes, { recursive: true });
		makeChildBare(work, remotes, "tests", "DECOY");
		const real = makeChildBare(work, remotes, "real-child", "REAL");

		const parentBare = path.join(remotes, "parent.git");
		git(["init", "--bare", "-b", "main", parentBare]);
		const parentSrc = path.join(work, "src-parent");
		git(["init", "-b", "main", parentSrc]);
		fs.writeFileSync(path.join(parentSrc, "README.md"), "parent");
		git(["add", "."], parentSrc);
		git(["commit", "-m", "parent init"], parentSrc);
		git(["clone", "--quiet", real.bare, path.join(parentSrc, "tests")]);
		git(["add", "tests"], parentSrc);
		git(["commit", "-m", "embed tests"], parentSrc);
		git(["remote", "add", "origin", parentBare], parentSrc);
		git(["push", "origin", "main"], parentSrc);

		const fresh = freshClone(parentBare);
		// Remove the materialized empty dir so the clone target does NOT pre-exist —
		// removeClone must then delete the whole directory it created (not just its
		// contents) when the decoy clone fails SHA verification.
		fs.rmSync(path.join(fresh, "tests"), { recursive: true, force: true });
		expect(fs.existsSync(path.join(fresh, "tests"))).toBe(false);

		const { results, exitCode } = api.embedded.restore({ cwd: fresh });
		expect(results[0].outcome).toBe("pinned-mismatch");
		expect(results[0].source).toBe("convention");
		expect(exitCode).toBe(1);
		// The clone we created was removed entirely — nothing left at the path.
		expect(fs.existsSync(path.join(fresh, "tests"))).toBe(false);
	});

	it("does not attempt removeClone when a failed clone left no directory behind", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		// Remove the materialized dir (target does NOT pre-exist) and point the clone
		// at a nonexistent repo. git creates then removes the dest on failure, so the
		// `if (fs.existsSync(absChild)) removeClone(...)` guard must take its false arm.
		fs.rmSync(path.join(fresh, "tests"), { recursive: true, force: true });
		api.embedded.registry.setUrl("tests", path.join(mkTmp(), "nonexistent.git"), fresh);

		const { results, exitCode } = api.embedded.restore({ cwd: fresh });
		expect(results[0].outcome).toBe("unresolved");
		expect(results[0].note).toMatch(/clone failed/);
		expect(exitCode).toBe(1);
		expect(fs.existsSync(path.join(fresh, "tests"))).toBe(false);
	});

	it("falls back to a detached checkout when the registered branch name is invalid (attach fails)", () => {
		const { parentBare, childSha } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		// A branch name git rejects for `checkout -B` (consecutive dots). Resolve/pin
		// succeed, so restore must still land the child — detached — rather than fail.
		api.embedded.registry.setBranch("tests", "bad..name", fresh);

		const { results, exitCode } = api.embedded.restore({ cwd: fresh });
		expect(exitCode).toBe(0);
		expect(results[0].outcome).toBe("restored");
		expect(results[0].branch).toBeNull();
		expect(results[0].note).toMatch(/could not attach branch bad\.\.name; checked out detached/);

		const child = path.join(fresh, "tests");
		expect(git(["rev-parse", "HEAD"], child)).toBe(childSha);
		expect(git(["branch", "--show-current"], child)).toBe(""); // detached
	});
});

// ─── sync.mjs ────────────────────────────────────────────────────────────────────

describe("sync edge branches", () => {
	it("is a clean no-op when cwd is not a git repository", () => {
		const notRepo = mkTmp();
		expect(api.embedded.sync({ cwd: notRepo })).toEqual({ results: [], exitCode: 0 });
	});

	it("honors --skip (skipped child is not touched)", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		const { results, exitCode } = api.embedded.sync({ cwd: fresh, skip: ["tests"] });
		expect(results).toHaveLength(1);
		expect(results[0].outcome).toBe("skipped");
		expect(exitCode).toBe(0);
	});

	it("skips a gitlink not named by the paths filter (no results)", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		expect(api.embedded.sync({ cwd: fresh, paths: ["not-a-real-path"] })).toEqual({ results: [], exitCode: 0 });
	});

	it("reports sync-failed when the gitlink path's parent is a file (ENOTDIR)", () => {
		const { parentBare } = makeParent({ gitlinkPath: "vendor/lib" });
		const fresh = freshClone(parentBare);
		fs.rmSync(path.join(fresh, "vendor"), { recursive: true, force: true });
		fs.writeFileSync(path.join(fresh, "vendor"), "not a directory");

		const { results, exitCode } = api.embedded.sync({ cwd: fresh });
		expect(results).toHaveLength(1);
		expect(results[0].outcome).toBe("sync-failed");
		expect(results[0].note).toMatch(/gitlink path unreadable \(ENOTDIR\)/);
		expect(exitCode).toBe(1);
	});

	it("treats a deleted materialized dir (lstat ENOENT) as an absent child, not a failure", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		// Delete the materialized empty dir so lstat throws ENOENT — the catch must
		// take its ENOENT arm and fall through to the no-repo handling, never mislabel
		// it a sync-failed anomaly.
		fs.rmSync(path.join(fresh, "tests"), { recursive: true, force: true });
		const { results, exitCode } = api.embedded.sync({ cwd: fresh, paths: ["tests"] });
		expect(results).toEqual([{ path: "tests", sha: expect.any(String), branch: null, note: "not present on disk — run restore", outcome: "no-repo" }]);
		expect(exitCode).toBe(0);
	});

	it("dry-run snaps a detached child optimistically without moving it", () => {
		const { work, parentBare, childSha } = makeParent({ gitlinkPath: "tests" });
		// Ambiguous inference → restore leaves the child detached, no branch registered.
		git(["push", "origin", "main:dev"], path.join(work, "src-tests"));
		const fresh = freshClone(parentBare);
		api.embedded.restore({ cwd: fresh });

		const sha2 = advanceChild(work, "tests", "v2");
		bumpPin(fresh, "tests", sha2);

		const { results, exitCode } = api.embedded.sync({ cwd: fresh, dryRun: true });
		expect(exitCode).toBe(0);
		expect(results[0].outcome).toBe("synced");
		expect(results[0].dryRun).toBe(true);
		expect(results[0].branch).toBeNull();

		const child = path.join(fresh, "tests");
		expect(git(["rev-parse", "HEAD"], child)).toBe(childSha); // unmoved
		expect(git(["branch", "--show-current"], child)).toBe(""); // still detached
	});

	it("reports sync-failed when ancestry cannot be tested (corrupt object graph)", () => {
		const { work, parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		api.embedded.restore({ cwd: fresh }); // child on main @ c1

		// Build a 3-commit chain c1→c2→c3; pin to c3. After making c3 locally
		// available, CORRUPT c2's object so the `merge-base --is-ancestor c1 c3`
		// walk (which passes through c2) errors hard (128) rather than returning a
		// clean ancestor/not-ancestor answer. A deleted middle object would merely
		// read as "not an ancestor" (exit 1); corruption is what forces the 128.
		// HEAD (c1) and the pin (c3) stay intact so status/cat-file still pass.
		const c2 = advanceChild(work, "tests", "v2");
		const c3 = advanceChild(work, "tests", "v3");
		bumpPin(fresh, "tests", c3);
		const child = path.join(fresh, "tests");
		git(["fetch", "origin"], child); // c2 + c3 now present locally
		const obj = path.join(child, ".git", "objects", c2.slice(0, 2), c2.slice(2));
		expect(fs.existsSync(obj)).toBe(true); // precondition: loose object
		fs.chmodSync(obj, 0o644); // loose objects are read-only
		fs.writeFileSync(obj, "GARBAGE-not-a-valid-zlib-object");

		const { results, exitCode } = api.embedded.sync({ cwd: fresh });
		expect(results[0].outcome).toBe("sync-failed");
		expect(results[0].note).toMatch(/could not test ancestry/);
		expect(exitCode).toBe(1);
	});

	it("reports sync-failed when moving the registered branch fails (index locked)", () => {
		const { work, parentBare, childSha } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		api.embedded.restore({ cwd: fresh }); // registers "main"

		const sha2 = advanceChild(work, "tests", "v2");
		bumpPin(fresh, "tests", sha2);
		const child = path.join(fresh, "tests");
		git(["fetch", "origin"], child); // make the pin present so no fetch is needed
		// A stale index.lock makes the branch-moving `checkout -B` fail while HEAD /
		// status / merge-base (which don't take the lock) still succeed.
		const lock = path.join(child, ".git", "index.lock");
		fs.writeFileSync(lock, "");
		try {
			const { results, exitCode } = api.embedded.sync({ cwd: fresh });
			expect(results[0].outcome).toBe("sync-failed");
			expect(results[0].branch).toBe("main");
			expect(results[0].note).toMatch(/could not move branch main/);
			expect(exitCode).toBe(1);
			expect(git(["rev-parse", "HEAD"], child)).toBe(childSha); // unmoved
		} finally {
			fs.rmSync(lock, { force: true });
		}
	});

	it("reports sync-failed when the detached checkout fails (index locked)", () => {
		const { work, parentBare, childSha } = makeParent({ gitlinkPath: "tests" });
		git(["push", "origin", "main:dev"], path.join(work, "src-tests")); // ambiguous → detached
		const fresh = freshClone(parentBare);
		api.embedded.restore({ cwd: fresh });

		const sha2 = advanceChild(work, "tests", "v2");
		bumpPin(fresh, "tests", sha2);
		const child = path.join(fresh, "tests");
		git(["fetch", "origin"], child);
		const lock = path.join(child, ".git", "index.lock");
		fs.writeFileSync(lock, "");
		try {
			const { results, exitCode } = api.embedded.sync({ cwd: fresh });
			expect(results[0].outcome).toBe("sync-failed");
			expect(results[0].note).toMatch(/could not check out/);
			expect(exitCode).toBe(1);
			expect(git(["rev-parse", "HEAD"], child)).toBe(childSha); // unmoved
		} finally {
			fs.rmSync(lock, { force: true });
		}
	});
});
