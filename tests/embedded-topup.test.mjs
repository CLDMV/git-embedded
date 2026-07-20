/**
 * Branch top-up coverage for the embedded engine's smaller modules. These
 * exercise the error paths, ambiguous/edge inputs, and layer-precedence
 * branches that embedded-provisioning.test.mjs leaves uncovered:
 *
 *   - branch.mjs   infer's "on no remote branch" (size 0) and git-error paths,
 *                  and attach's checkout-failure + best-effort-upstream branches.
 *   - gitlinks.mjs the not-a-repo, empty-tree, and regular-file-only filters,
 *                  plus a happy nested-path read.
 *   - record.mjs   the paths-filter miss, absent-child (no-repo vs silent skip),
 *                  and the non-repo getRepoRoot fallback.
 *   - registry.mjs entries-empty, recordOne no-repo/no-origin/detached, and the
 *                  setter/getter false/null branches.
 *   - resolve.mjs  conventionUrl null/no-delimiter edges and the full
 *                  local-config > manifest > base > convention precedence chain.
 *
 * Direct api unit calls against REAL temp git fixtures, matching the house
 * style (no over-mocking).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getApi } from "./_setup.mjs";

const tmpRoots = [];

function mkTmp() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-embedded-topup-"));
	tmpRoots.push(dir);
	return dir;
}

/** Throwing git for fixture setup. */
function git(args, cwd) {
	const res = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (res.status !== 0) throw new Error(`git ${args.join(" ")} (cwd=${cwd}) failed: ${res.stderr || res.stdout}`);
	return (res.stdout || "").trim();
}

/** Non-throwing git for operations expected to fail (upstream probes, etc.). */
function gitTry(args, cwd) {
	const res = spawnSync("git", args, { cwd, encoding: "utf8" });
	return { status: res.status ?? 1, stdout: (res.stdout || "").trim(), stderr: res.stderr || "" };
}

const BOGUS_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

/** A bare repo with one commit on `main` (pushed) + its origin URL + tip sha. */
function makeBare(marker = "c1") {
	const work = mkTmp();
	const bare = path.join(work, "child.git");
	git(["init", "--bare", "-b", "main", bare]);
	const seed = path.join(work, "seed");
	git(["init", "-b", "main", seed]);
	fs.writeFileSync(path.join(seed, "spec.txt"), marker);
	git(["add", "."], seed);
	git(["commit", "-m", "c1"], seed);
	git(["remote", "add", "origin", bare], seed);
	git(["push", "--quiet", "origin", "main"], seed);
	return { work, bare, seed, sha: git(["rev-parse", "HEAD"], seed) };
}

/** A working clone of a fresh bare (origin wired, on `main`). */
function makeBareWithClone(marker = "c1") {
	const { work, bare, seed, sha } = makeBare(marker);
	const clone = path.join(work, "clone");
	git(["clone", "--quiet", bare, clone]);
	return { work, bare, seed, clone, sha };
}

/** Init an empty parent repo and return its root (a real git repo, no children). */
function initRepo() {
	const root = mkTmp();
	git(["init", "-b", "main", root]);
	return root;
}

/**
 * Parent repo embedding a child at each of `gitlinkPaths`, pushed to a bare.
 * Returns the parent source dir (children present, committed), the parent bare,
 * and per-path child bare + pinned sha.
 */
function makeParentWithChildren(gitlinkPaths = ["tests"]) {
	const work = mkTmp();
	const remotes = path.join(work, "remotes");
	fs.mkdirSync(remotes, { recursive: true });

	const parentBare = path.join(remotes, "parent.git");
	git(["init", "--bare", "-b", "main", parentBare]);
	const parentSrc = path.join(work, "src-parent");
	git(["init", "-b", "main", parentSrc]);
	fs.writeFileSync(path.join(parentSrc, "README.md"), "parent");
	git(["add", "."], parentSrc);
	git(["commit", "-m", "parent init"], parentSrc);

	const childBares = {};
	for (const gp of gitlinkPaths) {
		const name = gp.split("/").pop();
		const bare = path.join(remotes, `${name}.git`);
		git(["init", "--bare", "-b", "main", bare]);
		const src = path.join(work, `src-${name}`);
		git(["init", "-b", "main", src]);
		fs.writeFileSync(path.join(src, "spec.txt"), name);
		git(["add", "."], src);
		git(["commit", "-m", `${name} init`], src);
		git(["remote", "add", "origin", bare], src);
		git(["push", "--quiet", "origin", "main"], src);
		childBares[gp] = { bare, sha: git(["rev-parse", "HEAD"], src) };
		git(["clone", "--quiet", bare, path.join(parentSrc, gp)]);
		git(["add", gp], parentSrc);
	}
	git(["commit", "-m", "embed children"], parentSrc);
	git(["remote", "add", "origin", parentBare], parentSrc);
	git(["push", "--quiet", "origin", "main"], parentSrc);

	return { work, parentBare, parentSrc, childBares };
}

function freshClone(parentBare) {
	const dir = path.join(mkTmp(), "clone");
	git(["clone", "--quiet", parentBare, dir]);
	return dir;
}

let originalEnv;
beforeEach(() => {
	originalEnv = { ...process.env };
	// Hermetic git: ignore host/global config, supply a commit identity.
	process.env.GIT_CONFIG_GLOBAL = os.platform() === "win32" ? "NUL" : "/dev/null";
	process.env.GIT_CONFIG_SYSTEM = os.platform() === "win32" ? "NUL" : "/dev/null";
	process.env.GIT_AUTHOR_NAME = "test";
	process.env.GIT_AUTHOR_EMAIL = "test@example.com";
	process.env.GIT_COMMITTER_NAME = "test";
	process.env.GIT_COMMITTER_EMAIL = "test@example.com";
});

afterEach(() => {
	process.env = originalEnv;
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

describe("api.embedded.branch.infer", () => {
	it("returns the single containing branch, then declines when the pin is ambiguous", () => {
		const { work, clone, sha } = makeBareWithClone();
		// Exactly one origin branch contains the pin.
		expect(api.embedded.branch.infer(clone, sha)).toBe("main");

		// A second origin branch carrying the same tip makes inference ambiguous.
		git(["push", "--quiet", "origin", "main:dev"], path.join(work, "seed"));
		git(["fetch", "--quiet", "origin"], clone);
		expect(api.embedded.branch.infer(clone, sha)).toBeNull();
	});

	it("returns null when the pin is on NO remote branch (unpushed local commit)", () => {
		const { clone } = makeBareWithClone();
		// A local commit ahead of origin/main → contained by no remote branch.
		fs.writeFileSync(path.join(clone, "local.txt"), "wip");
		git(["add", "."], clone);
		git(["commit", "-m", "local only"], clone);
		const localSha = git(["rev-parse", "HEAD"], clone);
		expect(git(["branch", "-r", "--contains", localSha], clone)).toBe(""); // precondition
		expect(api.embedded.branch.infer(clone, localSha)).toBeNull();
	});

	it("returns null when git itself errors (unknown commit)", () => {
		const { clone } = makeBareWithClone();
		expect(api.embedded.branch.infer(clone, BOGUS_SHA)).toBeNull();
	});
});

describe("api.embedded.branch.attach", () => {
	it("returns false and moves nothing when the checkout fails (bad sha)", () => {
		const { clone } = makeBareWithClone();
		expect(api.embedded.branch.attach(clone, "feature", BOGUS_SHA)).toBe(false);
		// HEAD stayed put and no dangling branch was created.
		expect(git(["branch", "--show-current"], clone)).toBe("main");
		expect(gitTry(["rev-parse", "--verify", "feature"], clone).status).not.toBe(0);
	});

	it("attaches to an existing branch and sets its upstream", () => {
		const { clone, sha } = makeBareWithClone();
		expect(api.embedded.branch.attach(clone, "main", sha)).toBe(true);
		expect(git(["rev-parse", "HEAD"], clone)).toBe(sha);
		expect(git(["branch", "--show-current"], clone)).toBe("main");
		expect(git(["rev-parse", "--abbrev-ref", "main@{upstream}"], clone)).toBe("origin/main");
	});

	it("succeeds (best-effort) even when no matching origin branch exists to track", () => {
		const { clone, sha } = makeBareWithClone();
		// No origin/brandnew exists — the soft --set-upstream-to fails but attach
		// must still report success with the local branch created at the pin.
		expect(api.embedded.branch.attach(clone, "brandnew", sha)).toBe(true);
		expect(git(["branch", "--show-current"], clone)).toBe("brandnew");
		expect(git(["rev-parse", "HEAD"], clone)).toBe(sha);
		expect(gitTry(["rev-parse", "--abbrev-ref", "brandnew@{upstream}"], clone).status).not.toBe(0);
	});
});

describe("api.embedded.gitlinks", () => {
	it("returns [] for a directory that is not a git repo", () => {
		expect(api.embedded.gitlinks(mkTmp())).toEqual([]);
	});

	it("returns [] for a repo whose HEAD tree is empty (empty commit)", () => {
		const repo = initRepo();
		git(["commit", "--allow-empty", "-m", "root"], repo);
		expect(api.embedded.gitlinks(repo)).toEqual([]);
	});

	it("returns [] for a repo containing only regular files (no gitlinks)", () => {
		const repo = initRepo();
		fs.writeFileSync(path.join(repo, "a.txt"), "x");
		fs.mkdirSync(path.join(repo, "sub"));
		fs.writeFileSync(path.join(repo, "sub", "b.txt"), "y");
		git(["add", "."], repo);
		git(["commit", "-m", "files"], repo);
		expect(api.embedded.gitlinks(repo)).toEqual([]);
	});

	it("enumerates gitlink path + pinned sha, including a nested path", () => {
		const { parentSrc, childBares } = makeParentWithChildren(["tests", "vendor/lib"]);
		const links = api.embedded.gitlinks(parentSrc);
		const byPath = Object.fromEntries(links.map((l) => [l.path, l.sha]));
		expect(Object.keys(byPath).sort()).toEqual(["tests", "vendor/lib"]);
		expect(byPath["tests"]).toBe(childBares["tests"].sha);
		expect(byPath["vendor/lib"]).toBe(childBares["vendor/lib"].sha);
	});
});

describe("api.embedded.record (uncovered paths)", () => {
	it("silently skips an absent child when no path filter is given", () => {
		const { parentBare } = makeParentWithChildren(["tests"]);
		const fresh = freshClone(parentBare); // child materialized empty, no .git
		expect(fs.existsSync(path.join(fresh, "tests", ".git"))).toBe(false);
		expect(api.embedded.record({ cwd: fresh }).results).toEqual([]);
	});

	it("reports no-repo for an explicitly requested absent child", () => {
		const { parentBare } = makeParentWithChildren(["tests"]);
		const fresh = freshClone(parentBare);
		const { results } = api.embedded.record({ cwd: fresh, paths: ["tests"] });
		expect(results).toEqual([{ path: "tests", outcome: "no-repo" }]);
	});

	it("records nothing when the path filter matches no gitlink", () => {
		const { parentBare } = makeParentWithChildren(["tests"]);
		const fresh = freshClone(parentBare);
		expect(api.embedded.record({ cwd: fresh, paths: ["does-not-exist"] }).results).toEqual([]);
	});

	it("falls back to cwd (records nothing) when cwd is not a git repo", () => {
		const notRepo = mkTmp();
		expect(api.embedded.record({ cwd: notRepo }).results).toEqual([]);
	});
});

describe("api.embedded.registry", () => {
	it("entries returns [] when no embedded.* keys are set", () => {
		expect(api.embedded.registry.entries(initRepo())).toEqual([]);
	});

	it("entries parses url-only and url+branch subsections independently", () => {
		const root = initRepo();
		api.embedded.registry.setUrl("alpha", "URL_A", root);
		api.embedded.registry.setUrl("beta", "URL_B", root);
		api.embedded.registry.setBranch("beta", "main", root);
		const byPath = Object.fromEntries(api.embedded.registry.entries(root).map((e) => [e.path, e]));
		expect(byPath.alpha).toEqual({ path: "alpha", url: "URL_A" });
		expect(byPath.beta).toEqual({ path: "beta", url: "URL_B", branch: "main" });
	});

	it("setters/getters round-trip; unset reads are null and non-repo writes are false", () => {
		const root = initRepo();
		expect(api.embedded.registry.getUrl("tests", root)).toBeNull(); // unset
		expect(api.embedded.registry.getBranch("tests", root)).toBeNull(); // unset
		expect(api.embedded.registry.setUrl("tests", "U", root)).toBe(true);
		expect(api.embedded.registry.getUrl("tests", root)).toBe("U");
		expect(api.embedded.registry.setBranch("tests", "b", root)).toBe(true);
		expect(api.embedded.registry.getBranch("tests", root)).toBe("b");

		const notRepo = mkTmp();
		expect(api.embedded.registry.setUrl("tests", "U", notRepo)).toBe(false);
		expect(api.embedded.registry.setBranch("tests", "b", notRepo)).toBe(false);
		expect(api.embedded.registry.getUrl("tests", notRepo)).toBeNull();
	});

	it("recordOne reports no-repo when the child has no .git", () => {
		const root = initRepo();
		expect(api.embedded.registry.recordOne("tests", root)).toEqual({ path: "tests", outcome: "no-repo" });
	});

	it("recordOne reports no-origin for a present child with no origin remote", () => {
		const root = initRepo();
		const child = path.join(root, "tests");
		git(["init", "-b", "main", child]);
		fs.writeFileSync(path.join(child, "f.txt"), "x");
		git(["add", "."], child);
		git(["commit", "-m", "c"], child);
		expect(api.embedded.registry.recordOne("tests", root)).toEqual({ path: "tests", outcome: "no-origin" });
		// Nothing was written to the parent registry on failure.
		expect(api.embedded.registry.getUrl("tests", root)).toBeNull();
	});

	it("recordOne records the url but leaves branch null for a detached-HEAD child", () => {
		const root = initRepo();
		const { bare, sha } = makeBare();
		const child = path.join(root, "tests");
		git(["clone", "--quiet", bare, child]);
		git(["checkout", "--quiet", "--detach", sha], child); // no symbolic-ref for HEAD

		const res = api.embedded.registry.recordOne("tests", root);
		expect(res.outcome).toBe("recorded");
		expect(res.url).toBe(bare);
		expect(res.branch).toBeNull();
		// url was persisted; branch was NOT (setBranch skipped for detached HEAD).
		expect(api.embedded.registry.getUrl("tests", root)).toBe(bare);
		expect(api.embedded.registry.getBranch("tests", root)).toBeNull();
	});
});

describe("api.embedded.resolve.conventionUrl", () => {
	const cu = (...a) => api.embedded.resolve.conventionUrl(...a);

	it("returns null with no parent origin", () => {
		expect(cu(null, "tests")).toBeNull();
	});

	it("returns null for an origin with neither a slash nor a colon", () => {
		expect(cu("bareword", "tests")).toBeNull();
	});

	it("splits a URL-style origin on the last slash (trailing slash trimmed, nested basename)", () => {
		expect(cu("https://h/o/parent.git/", "vendor/foo")).toBe("https://h/o/foo.git");
		expect(cu("https://h/o/parent.git", "tests")).toBe("https://h/o/tests.git");
	});

	it("splits an scp-style root origin (no slash) on the last colon", () => {
		expect(cu("git@host:parent.git", "tests")).toBe("git@host:tests.git");
	});
});

describe("api.embedded.resolve (layer precedence)", () => {
	it("prefers local-config > manifest > base > convention, then reports nothing", () => {
		const repo = initRepo();
		const manifest = { children: { tests: { url: "MANIFEST_URL" } } };
		const full = { cwd: repo, manifest, base: "https://base", parentOrigin: "https://h/o/parent.git" };

		// Layer 1: local-config beats a supplied manifest/base/origin.
		api.embedded.registry.setUrl("tests", "CFG_URL", repo);
		expect(api.embedded.resolve("tests", full)).toEqual({ url: "CFG_URL", source: "local-config" });

		// Layer 2: with config cleared, the manifest wins over base/convention.
		git(["config", "--local", "--unset", "embedded.tests.url"], repo);
		expect(api.embedded.resolve("tests", full)).toEqual({ url: "MANIFEST_URL", source: "manifest" });

		// Layer 3: a manifest entry present but WITHOUT a url falls through to --base.
		const baseOpts = {
			cwd: repo,
			manifest: { children: { tests: {} } },
			base: "https://base",
			parentOrigin: "https://h/o/parent.git"
		};
		expect(api.embedded.resolve("tests", baseOpts)).toEqual({ url: "https://base/tests.git", source: "base" });

		// Layer 4: only the parent origin remains → convention sibling.
		expect(api.embedded.resolve("tests", { cwd: repo, parentOrigin: "https://h/o/parent.git" })).toEqual({
			url: "https://h/o/tests.git",
			source: "convention"
		});

		// Nothing resolves: no config, no manifest, no base, no origin.
		expect(api.embedded.resolve("tests", { cwd: repo })).toEqual({ url: null, source: null });
	});

	it("ignores a foreign/inherited manifest key (own-property check)", () => {
		const repo = initRepo();
		// "constructor" is on Object.prototype but NOT an own key of children.
		const manifest = { children: {} };
		expect(api.embedded.resolve("constructor", { cwd: repo, manifest })).toEqual({ url: null, source: null });
	});
});
