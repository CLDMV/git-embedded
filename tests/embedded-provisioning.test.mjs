import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getApi } from "./_setup.mjs";

const tmpRoots = [];

function mkTmp() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-embedded-prov-"));
	tmpRoots.push(dir);
	return dir;
}

// Whether this environment can CREATE symlinks — Windows requires Developer
// Mode or elevation. The symlink-guard cases skip where creation is denied;
// the guards themselves need no symlink rights and stay exercised on POSIX CI.
const canSymlink = (() => {
	let dir = null;
	try {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-embedded-symlink-probe-"));
		fs.symlinkSync(dir, path.join(dir, "probe"), "dir");
		return true;
	} catch {
		return false;
	} finally {
		// Clean up on BOTH paths — a failed probe (Windows without Developer
		// Mode) must not leak the temp dir.
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
})();

function git(args, cwd) {
	const res = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (res.status !== 0) throw new Error(`git ${args.join(" ")} (cwd=${cwd}) failed: ${res.stderr || res.stdout}`);
	return (res.stdout || "").trim();
}

/**
 * Build a bare "child source" repo with one commit and return its bare path +
 * pinned SHA. The bare lives under `remotes/<bareName>.git`.
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
	const sha = git(["rev-parse", "HEAD"], src);
	return { bare, sha };
}

/**
 * Assemble a parent repo carrying an anonymous gitlink and push it to a bare.
 * The gitlink at `gitlinkPath` is pinned to `pinBare`'s HEAD; the convention
 * sibling name is controlled by `childBareName` (defaults to the gitlink
 * basename → convention resolves; set it different to obscure the child).
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
	git(["clone", "--quiet", child.bare, path.join(parentSrc, gitlinkPath)]);
	git(["add", gitlinkPath], parentSrc);
	git(["commit", "-m", `embed ${gitlinkPath}`], parentSrc);
	git(["remote", "add", "origin", parentBare], parentSrc);
	git(["push", "origin", "main"], parentSrc);

	return { work, remotes, parentBare, childBare: child.bare, childSha: child.sha, gitlinkPath };
}

function freshClone(parentBare) {
	const dir = path.join(mkTmp(), "clone");
	git(["clone", "--quiet", parentBare, dir]);
	return dir;
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

describe("api.embedded.restore (convention)", () => {
	it("restores a convention-resolvable child end-to-end and writes the registry", () => {
		const { parentBare, childBare, childSha } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);

		// Fresh clone materializes the gitlink as an empty dir with no .git.
		expect(fs.existsSync(path.join(fresh, "tests"))).toBe(true);
		expect(fs.existsSync(path.join(fresh, "tests", ".git"))).toBe(false);

		const { results, exitCode } = api.embedded.restore({ cwd: fresh });
		expect(exitCode).toBe(0);
		expect(results).toHaveLength(1);
		expect(results[0].outcome).toBe("restored");
		expect(results[0].source).toBe("convention");
		expect(results[0].url).toBe(childBare);

		// Pinned SHA is checked out (detached) inside the child.
		expect(fs.existsSync(path.join(fresh, "tests", ".git"))).toBe(true);
		expect(git(["rev-parse", "HEAD"], path.join(fresh, "tests"))).toBe(childSha);

		// Registry recorded so day-2 does not re-derive.
		expect(api.embedded.registry.getUrl("tests", fresh)).toBe(childBare);

		// Day-2 re-restore is a no-op.
		const again = api.embedded.restore({ cwd: fresh });
		expect(again.results[0].outcome).toBe("already-present");
		expect(again.exitCode).toBe(0);
	});

	it("honors --skip for a partial restore (skipped child does not fail the run)", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		const { results, exitCode } = api.embedded.restore({ cwd: fresh, skip: ["tests"] });
		expect(results[0].outcome).toBe("skipped");
		expect(exitCode).toBe(0);
		expect(fs.existsSync(path.join(fresh, "tests", ".git"))).toBe(false);
	});
});

describe("api.embedded.restore (obscured child)", () => {
	it("is unresolved by convention, then link into the empty dir makes a later restore already-present", () => {
		// Child bare name differs from the gitlink basename → convention guesses
		// a non-existent sibling and fails closed.
		const { parentBare, childBare } = makeParent({ gitlinkPath: "tests", childBareName: "secret-xyz" });
		const fresh = freshClone(parentBare);

		const first = api.embedded.restore({ cwd: fresh });
		expect(first.results[0].outcome).toBe("unresolved");
		expect(first.exitCode).toBe(1);
		// Nothing planted; the materialized empty dir is left intact.
		expect(fs.existsSync(path.join(fresh, "tests", ".git"))).toBe(false);

		// link the real (obscured) URL into the empty gitlink dir.
		process.chdir(fresh);
		vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new Error(`process.exit(${code})`);
		});
		api.cli.link.run("tests", childBare);
		process.chdir(originalCwd);

		expect(fs.existsSync(path.join(fresh, "tests", ".git"))).toBe(true);
		expect(api.embedded.registry.getUrl("tests", fresh)).toBe(childBare);

		const second = api.embedded.restore({ cwd: fresh });
		expect(second.results[0].outcome).toBe("already-present");
		expect(second.exitCode).toBe(0);
	});
});

describe("api.embedded.restore (pinned-mismatch)", () => {
	it("removes a clone whose repo lacks the pinned SHA and exits non-zero", () => {
		const work = mkTmp();
		const remotes = path.join(work, "remotes");
		fs.mkdirSync(remotes, { recursive: true });

		// Decoy at the convention target (tests.git) with unrelated history.
		makeChildBare(work, remotes, "tests", "DECOY");
		// Real pin lives in a differently-named bare that convention never finds.
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
		const { results, exitCode } = api.embedded.restore({ cwd: fresh });

		expect(results[0].outcome).toBe("pinned-mismatch");
		expect(results[0].source).toBe("convention");
		expect(exitCode).toBe(1);

		// The clone we created was removed; the pre-existing empty dir remains empty.
		expect(fs.existsSync(path.join(fresh, "tests", ".git"))).toBe(false);
		expect(fs.readdirSync(path.join(fresh, "tests"))).toHaveLength(0);
		// No registry entry was written on failure.
		expect(api.embedded.registry.getUrl("tests", fresh)).toBeNull();
	});
});

describe("record / export round-trip", () => {
	it("exports a manifest that resolves an obscured child on a second machine", () => {
		const { parentBare, childBare, childSha } = makeParent({ gitlinkPath: "tests", childBareName: "secret-xyz" });

		// Machine A: link the obscured child, then export a manifest.
		const machineA = freshClone(parentBare);
		process.chdir(machineA);
		vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new Error(`process.exit(${code})`);
		});
		api.cli.link.run("tests", childBare);
		process.chdir(originalCwd);

		const entries = api.embedded.registry.entries(machineA);
		expect(entries).toEqual([{ path: "tests", url: childBare, branch: "main" }]);

		const manifest = api.embedded.manifest.build(entries);
		const manifestFile = path.join(mkTmp(), "children.json");
		fs.writeFileSync(manifestFile, api.embedded.manifest.serialize(manifest));

		// Round-trip through disk.
		const parsed = api.embedded.manifest.read(manifestFile);
		expect(parsed.version).toBe(1);
		expect(parsed.children.tests.url).toBe(childBare);

		// Machine B: convention cannot find the child; --from manifest resolves it.
		const machineB = freshClone(parentBare);
		const conv = api.embedded.restore({ cwd: machineB });
		expect(conv.results[0].outcome).toBe("unresolved");

		const viaManifest = api.embedded.restore({ cwd: machineB, from: manifestFile });
		expect(viaManifest.results[0].outcome).toBe("restored");
		expect(viaManifest.results[0].source).toBe("manifest");
		expect(viaManifest.exitCode).toBe(0);
		expect(git(["rev-parse", "HEAD"], path.join(machineB, "tests"))).toBe(childSha);
	});

	it("record writes the child's origin URL into the local registry", () => {
		const { parentBare, childBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		api.embedded.restore({ cwd: fresh });
		// Clear the registry entry restore wrote, to prove record repopulates it.
		git(["config", "--local", "--unset", "embedded.tests.url"], fresh);
		expect(api.embedded.registry.getUrl("tests", fresh)).toBeNull();

		const { results } = api.embedded.record({ cwd: fresh });
		expect(results).toHaveLength(1);
		expect(results[0].outcome).toBe("recorded");
		expect(results[0].url).toBe(childBare);
		expect(api.embedded.registry.getUrl("tests", fresh)).toBe(childBare);
	});
});

describe("api.cli.link (empty-dir fix)", () => {
	it("clones into an empty gitlink dir and refuses a non-empty one", () => {
		const { parentBare, childBare } = makeParent({ gitlinkPath: "tests", childBareName: "secret-xyz" });
		const fresh = freshClone(parentBare);
		process.chdir(fresh);
		vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new Error(`process.exit(${code})`);
		});

		// Empty materialized dir → link succeeds.
		expect(fs.readdirSync(path.join(fresh, "tests"))).toHaveLength(0);
		expect(() => api.cli.link.run("tests", childBare)).not.toThrow();
		expect(fs.existsSync(path.join(fresh, "tests", ".git"))).toBe(true);

		// Non-empty, non-repo dir → link refuses with exit code 2.
		fs.mkdirSync(path.join(fresh, "vendor"));
		fs.writeFileSync(path.join(fresh, "vendor", "junk.txt"), "x");
		expect(() => api.cli.link.run("vendor", childBare)).toThrow(/process\.exit\(2\)/);
	});
});

describe("target safety guards (review hardening)", () => {
	it("restore refuses a non-empty directory at a gitlink path and leaves it untouched", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		// User data sitting in the materialized gitlink dir must never be touched.
		fs.writeFileSync(path.join(fresh, "tests", "precious.txt"), "user data");
		const { results, exitCode } = api.embedded.restore({ cwd: fresh });
		expect(results[0].outcome).toBe("unresolved");
		expect(results[0].note).toMatch(/not empty.*refusing/);
		expect(exitCode).toBe(1);
		expect(fs.readFileSync(path.join(fresh, "tests", "precious.txt"), "utf8")).toBe("user data");
		expect(fs.existsSync(path.join(fresh, "tests", ".git"))).toBe(false);
	});

	it("restore refuses a file at a gitlink path and leaves it untouched", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		fs.rmdirSync(path.join(fresh, "tests"));
		fs.writeFileSync(path.join(fresh, "tests"), "a file, not a dir");
		const { results, exitCode } = api.embedded.restore({ cwd: fresh });
		expect(results[0].outcome).toBe("unresolved");
		expect(results[0].note).toMatch(/not a directory.*refusing/);
		expect(exitCode).toBe(1);
		expect(fs.readFileSync(path.join(fresh, "tests"), "utf8")).toBe("a file, not a dir");
	});

	it("link refuses a file target up-front with exit 2", () => {
		const { parentBare, childBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		process.chdir(fresh);
		vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new Error(`process.exit(${code})`);
		});
		fs.writeFileSync(path.join(fresh, "somefile"), "x");
		expect(() => api.cli.link.run("somefile", childBare)).toThrow(/process\.exit\(2\)/);
		expect(fs.readFileSync(path.join(fresh, "somefile"), "utf8")).toBe("x");
	});

	it("manifest.read rejects a missing or unsupported version", () => {
		const dir = mkTmp();
		const noVersion = path.join(dir, "no-version.json");
		fs.writeFileSync(noVersion, JSON.stringify({ children: {} }));
		expect(() => api.embedded.manifest.read(noVersion)).toThrow(/version/);
		const badVersion = path.join(dir, "bad-version.json");
		fs.writeFileSync(badVersion, JSON.stringify({ version: 2, children: {} }));
		expect(() => api.embedded.manifest.read(badVersion)).toThrow(/unsupported version 2/);
	});
});

describe("review hardening round 2 (scp-root convention + symlink guards)", () => {
	it("derives the convention sibling for a scp-style origin with no path component", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		// Repo at the scp path root: no "/" in the origin — sibling lives after the last ":".
		git(["remote", "set-url", "origin", "git@host.example:parent.git"], fresh);
		const { results } = api.embedded.restore({ cwd: fresh, dryRun: true });
		expect(results[0].source).toBe("convention");
		expect(results[0].url).toBe("git@host.example:tests.git");
	});

	it.skipIf(!canSymlink)("restore refuses a symlink at a gitlink path — even one pointing at an empty dir", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		const target = path.join(mkTmp(), "elsewhere");
		fs.mkdirSync(target);
		fs.rmdirSync(path.join(fresh, "tests"));
		fs.symlinkSync(target, path.join(fresh, "tests"), "dir");
		const { results, exitCode } = api.embedded.restore({ cwd: fresh });
		expect(results[0].outcome).toBe("unresolved");
		expect(results[0].note).toMatch(/symbolic link.*refusing/);
		expect(exitCode).toBe(1);
		// The symlink target stays untouched — nothing was cloned through it.
		expect(fs.readdirSync(target)).toHaveLength(0);
		expect(fs.lstatSync(path.join(fresh, "tests")).isSymbolicLink()).toBe(true);
	});

	it.skipIf(!canSymlink)("restore refuses a BROKEN symlink at a gitlink path", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		fs.rmdirSync(path.join(fresh, "tests"));
		fs.symlinkSync(path.join(fresh, "does-not-exist"), path.join(fresh, "tests"), "dir");
		const { results, exitCode } = api.embedded.restore({ cwd: fresh });
		expect(results[0].outcome).toBe("unresolved");
		expect(results[0].note).toMatch(/symbolic link.*refusing/);
		expect(exitCode).toBe(1);
		expect(fs.lstatSync(path.join(fresh, "tests")).isSymbolicLink()).toBe(true);
	});

	it.skipIf(!canSymlink)("link refuses a symlink target up-front with exit 2", () => {
		const { parentBare, childBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		process.chdir(fresh);
		vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new Error(`process.exit(${code})`);
		});
		const target = path.join(mkTmp(), "elsewhere2");
		fs.mkdirSync(target);
		fs.symlinkSync(target, path.join(fresh, "linked"), "dir");
		expect(() => api.cli.link.run("linked", childBare)).toThrow(/process\.exit\(2\)/);
		expect(fs.readdirSync(target)).toHaveLength(0);
	});
});

describe("manifest shape hardening (review round 4)", () => {
	it("read rejects an array children value", () => {
		const dir = mkTmp();
		const f = path.join(dir, "array-children.json");
		fs.writeFileSync(f, JSON.stringify({ version: 1, children: [] }));
		expect(() => api.embedded.manifest.read(f)).toThrow(/children/);
	});

	it("build treats a __proto__ child path as a plain key without polluting prototypes", () => {
		const manifest = api.embedded.manifest.build([{ path: "__proto__", url: "ssh://h/p.git" }]);
		expect(Object.hasOwn(manifest.children, "__proto__")).toBe(true);
		expect({}.url).toBeUndefined(); // Object.prototype untouched
		// Round-trips through JSON as an ordinary key.
		expect(JSON.parse(JSON.stringify(manifest)).children["__proto__"].url).toBe("ssh://h/p.git");
	});
});
