import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getApi } from "./_setup.mjs";

// These exercise the CLI command wrappers (src/api/cli/{restore,record,export,sync}.mjs)
// against REAL temp git repos — the same fixture style as embedded-provisioning.test.vitest.mjs.
// Each wrapper reads process.cwd(), prints through self.report.* (console.log/error), and
// restore/sync end with process.exit(code); we chdir into the fixture, capture the output,
// and translate the process.exit into a return code.

const tmpRoots = [];

function mkTmp() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-embedded-cli-"));
	tmpRoots.push(dir);
	return dir;
}

function git(args, cwd) {
	const res = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (res.status !== 0) throw new Error(`git ${args.join(" ")} (cwd=${cwd}) failed: ${res.stderr || res.stdout}`);
	return (res.stdout || "").trim();
}

/**
 * Build a bare "child source" repo with one commit; return its bare path + SHA.
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
 * Assemble a parent repo carrying one anonymous gitlink and push it to a bare.
 * `childBareName` defaults to the gitlink basename (convention resolves); set it
 * different to obscure the child so convention fails.
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

/**
 * A parent whose convention target (tests.git) is a DECOY with unrelated
 * history, while the real pin lives in a differently-named bare convention never
 * finds — the setup that makes restore end `pinned-mismatch`.
 */
function makeParentPinnedMismatch() {
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
	return { parentBare };
}

function freshClone(parentBare) {
	const dir = path.join(mkTmp(), "clone");
	git(["clone", "--quiet", parentBare, dir]);
	return dir;
}

/** A plain repo with one commit and NO gitlinks. */
function makePlainRepo() {
	const dir = path.join(mkTmp(), "plain");
	git(["init", "-b", "main", dir]);
	fs.writeFileSync(path.join(dir, "README.md"), "plain");
	git(["add", "."], dir);
	git(["commit", "-m", "init"], dir);
	return dir;
}

/** Advance the child source by a commit (pushed by default); return new SHA. */
function advanceChild(work, bareName, marker, { push = true } = {}) {
	const src = path.join(work, `src-${bareName}`);
	fs.writeFileSync(path.join(src, "next.txt"), marker);
	git(["add", "."], src);
	git(["commit", "-m", `${bareName} advance`], src);
	if (push) git(["push", "origin", "main"], src);
	return git(["rev-parse", "HEAD"], src);
}

/** Move the parent's gitlink pin to `sha` without touching the child on disk. */
function bumpPin(parentDir, childPath, sha) {
	git(["update-index", "--cacheinfo", `160000,${sha},${childPath}`], parentDir);
	git(["commit", "-m", `bump ${childPath} pin`], parentDir);
}

// ---- output + process.exit capture ---------------------------------------

let logLines;
let errLines;
let stdoutChunks;

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
 * Run a CLI wrapper. restore/sync call process.exit(code) (mocked to throw); we
 * translate that back into the returned exit code. record/export do not exit and
 * return null. A non-exit throw (a real error) propagates.
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

	logLines = [];
	errLines = [];
	stdoutChunks = [];
	vi.spyOn(console, "log").mockImplementation((...a) => {
		logLines.push(a.map(String).join(" "));
	});
	vi.spyOn(console, "error").mockImplementation((...a) => {
		errLines.push(a.map(String).join(" "));
	});
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		stdoutChunks.push(String(chunk));
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

describe("api.cli.restore.run", () => {
	it("reports 'No embedded gitlinks in HEAD.' and exits 0 for a repo with no gitlinks", () => {
		const repo = makePlainRepo();
		process.chdir(repo);
		const code = runCli(() => api.cli.restore.run([], {}));
		expect(code).toBe(0);
		expect(logText()).toContain("No embedded gitlinks in HEAD.");
	});

	it("restores a convention-resolvable child, prints the branch, and summarizes 1 restored", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		process.chdir(fresh);

		const code = runCli(() => api.cli.restore.run([], {}));
		expect(code).toBe(0);
		expect(logText()).toContain("restored tests from convention");
		expect(logText()).toContain("on branch main");
		expect(logText()).toContain("1 restored, 0 unchanged, 0 failed.");
		expect(fs.existsSync(path.join(fresh, "tests", ".git"))).toBe(true);
	});

	it("--dry-run reports 'would restore' with the resolvable summary and clones nothing", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		process.chdir(fresh);

		const code = runCli(() => api.cli.restore.run([], { dryRun: true }));
		expect(code).toBe(0);
		expect(logText()).toContain("would restore tests from convention");
		expect(logText()).toContain("1 resolvable, 0 unchanged, 0 failed.");
		// Nothing was cloned.
		expect(fs.existsSync(path.join(fresh, "tests", ".git"))).toBe(false);
	});

	it("--skip (comma string) skips the child, warns, and counts it as skipped", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		process.chdir(fresh);

		const code = runCli(() => api.cli.restore.run([], { skip: "tests" }));
		expect(code).toBe(0);
		expect(logText()).toContain("tests skipped");
		expect(logText()).toContain("0 restored, 0 unchanged, 1 skipped, 0 failed.");
		expect(fs.existsSync(path.join(fresh, "tests", ".git"))).toBe(false);
	});

	it("--base derives the child URL and labels the source 'base'", () => {
		const { parentBare, remotes } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		process.chdir(fresh);

		// base=<remotes> → <remotes>/tests.git, the real bare; base beats convention.
		const code = runCli(() => api.cli.restore.run([], { base: remotes }));
		expect(code).toBe(0);
		expect(logText()).toContain("restored tests from base");
		expect(fs.existsSync(path.join(fresh, "tests", ".git"))).toBe(true);
	});

	it("--from resolves an obscured child through a manifest (source 'manifest')", () => {
		const { parentBare, childBare } = makeParent({ gitlinkPath: "tests", childBareName: "secret-xyz" });
		const fresh = freshClone(parentBare);

		const manifestFile = path.join(mkTmp(), "children.json");
		const manifest = api.embedded.manifest.build([{ path: "tests", url: childBare, branch: "main" }]);
		fs.writeFileSync(manifestFile, api.embedded.manifest.serialize(manifest));

		process.chdir(fresh);
		const code = runCli(() => api.cli.restore.run([], { from: manifestFile }));
		expect(code).toBe(0);
		expect(logText()).toContain("restored tests from manifest");
		expect(logText()).toContain("on branch main");
		expect(fs.existsSync(path.join(fresh, "tests", ".git"))).toBe(true);
	});

	it("an unresolvable (obscured) child is an error line and exits 1", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests", childBareName: "secret-xyz" });
		const fresh = freshClone(parentBare);
		process.chdir(fresh);

		const code = runCli(() => api.cli.restore.run([], {}));
		expect(code).toBe(1);
		expect(errText()).toContain("tests unresolved");
		expect(logText()).toContain("0 restored, 0 unchanged, 1 failed.");
		expect(fs.existsSync(path.join(fresh, "tests", ".git"))).toBe(false);
	});

	it("a pinned-mismatch (decoy sibling) is an error line and exits 1", () => {
		const { parentBare } = makeParentPinnedMismatch();
		const fresh = freshClone(parentBare);
		process.chdir(fresh);

		const code = runCli(() => api.cli.restore.run([], {}));
		expect(code).toBe(1);
		expect(errText()).toContain("tests pinned-mismatch");
		expect(logText()).toContain("0 restored, 0 unchanged, 1 failed.");
	});

	it("a second restore reports already-present (warn) and counts it as unchanged", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		process.chdir(fresh);

		expect(runCli(() => api.cli.restore.run([], {}))).toBe(0);
		resetOutput();

		const code = runCli(() => api.cli.restore.run([], {}));
		expect(code).toBe(0);
		expect(logText()).toContain("tests already present");
		expect(logText()).toContain("0 restored, 1 unchanged, 0 failed.");
	});
});

describe("api.cli.record.run", () => {
	it("reports nothing to record when no child is present on disk", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare); // gitlink present but child not restored
		process.chdir(fresh);

		const code = runCli(() => api.cli.record.run([]));
		expect(code).toBeNull(); // record never calls process.exit
		expect(logText()).toContain("No embedded children present on disk to record.");
	});

	it("records a present child's origin URL + branch into the local registry", () => {
		const { parentBare, childBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		process.chdir(fresh);
		runCli(() => api.cli.restore.run([], {})); // child present, origin wired
		resetOutput();

		runCli(() => api.cli.record.run([]));
		expect(logText()).toContain(`tests → ${childBare}`);
		expect(logText()).toContain("(main)");
		expect(logText()).toContain("Recorded 1 of 1 into the local registry (not committed).");
		expect(api.embedded.registry.getUrl("tests", fresh)).toBe(childBare);
	});

	it("warns 'not present on disk' for an explicitly requested absent child", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare); // not restored
		process.chdir(fresh);

		runCli(() => api.cli.record.run(["tests"]));
		expect(logText()).toContain("tests not present on disk");
		expect(logText()).toContain("Recorded 0 of 1 into the local registry (not committed).");
	});

	it("warns 'has no remote.origin.url' when a present child lost its origin", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		process.chdir(fresh);
		runCli(() => api.cli.restore.run([], {}));
		// Strip the child's origin so recordOne finds .git but no URL.
		git(["remote", "remove", "origin"], path.join(fresh, "tests"));
		resetOutput();

		runCli(() => api.cli.record.run([]));
		expect(logText()).toContain("tests has no remote.origin.url");
		expect(logText()).toContain("Recorded 0 of 1 into the local registry (not committed).");
	});
});

describe("api.cli.export.run", () => {
	it("writes the manifest to stdout by default", () => {
		const { parentBare, childBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		process.chdir(fresh);
		runCli(() => api.cli.restore.run([], {})); // populates the registry
		resetOutput();

		const code = runCli(() => api.cli.export.run({}));
		expect(code).toBeNull();
		const parsed = JSON.parse(outText());
		expect(parsed.version).toBe(1);
		expect(parsed.children.tests.url).toBe(childBare);
		expect(parsed.children.tests.branch).toBe("main");
	});

	it("-o <file> outside the worktree writes the file and does not touch git excludes", () => {
		const { parentBare, childBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		process.chdir(fresh);
		runCli(() => api.cli.restore.run([], {}));
		resetOutput();

		const outFile = path.join(mkTmp(), "sub", "children.json");
		runCli(() => api.cli.export.run({ o: outFile }));

		expect(logText()).toContain(`Wrote manifest to ${outFile}`);
		expect(logText()).toContain("1 children");
		expect(logText()).toContain("do NOT commit");
		expect(logText()).not.toContain("exclude");

		const parsed = JSON.parse(fs.readFileSync(outFile, "utf8"));
		expect(parsed.children.tests.url).toBe(childBare);
	});

	it("-o inside the worktree excludes the file once, not twice on a re-export", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		process.chdir(fresh);
		runCli(() => api.cli.restore.run([], {}));
		resetOutput();

		// First export: file written under the worktree + added to info/exclude.
		runCli(() => api.cli.export.run({ o: "children.json" }));
		expect(logText()).toContain("added children.json to .git/info/exclude");
		const excludeFile = path.join(fresh, ".git", "info", "exclude");
		expect(fs.readFileSync(excludeFile, "utf8")).toContain("children.json");
		expect(fs.existsSync(path.join(fresh, "children.json"))).toBe(true);
		resetOutput();

		// Second export: already excluded, so no courtesy line is printed.
		runCli(() => api.cli.export.run({ o: "children.json" }));
		expect(logText()).toContain("Wrote manifest to");
		expect(logText()).not.toContain("added children.json");
	});

	it("--scan records present children before serializing the manifest", () => {
		const { parentBare, childBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		process.chdir(fresh);
		runCli(() => api.cli.restore.run([], {}));
		// Wipe the registry restore wrote, so only --scan can repopulate it.
		git(["config", "--local", "--unset", "embedded.tests.url"], fresh);
		git(["config", "--local", "--unset", "embedded.tests.branch"], fresh);
		expect(api.embedded.registry.entries(fresh)).toEqual([]);
		resetOutput();

		const outFile = path.join(mkTmp(), "scanned.json");
		runCli(() => api.cli.export.run({ scan: true, o: outFile }));

		const parsed = JSON.parse(fs.readFileSync(outFile, "utf8"));
		expect(parsed.children.tests.url).toBe(childBare);
	});
});

describe("api.cli.sync.run", () => {
	it("reports nothing to sync and exits 0 when no child is present", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare); // never restored
		process.chdir(fresh);

		const code = runCli(() => api.cli.sync.run([], {}));
		expect(code).toBe(0);
		expect(logText()).toContain("No embedded children present to sync.");
	});

	it("fast-forwards a moved pin, prints the branch, and summarizes 1 synced", () => {
		const { work, parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		process.chdir(fresh);
		runCli(() => api.cli.restore.run([], {}));

		const sha2 = advanceChild(work, "tests", "v2");
		bumpPin(fresh, "tests", sha2);
		resetOutput();

		const code = runCli(() => api.cli.sync.run([], {}));
		expect(code).toBe(0);
		expect(logText()).toContain(`synced tests → ${sha2.slice(0, 12)}`);
		expect(logText()).toContain("(branch main)");
		expect(logText()).toContain("1 synced, 0 unchanged, 0 left alone, 0 failed.");
		expect(git(["rev-parse", "HEAD"], path.join(fresh, "tests"))).toBe(sha2);
	});

	it("--dry-run reports 'would sync' with the syncable summary and moves nothing", () => {
		const { work, parentBare, childSha } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		process.chdir(fresh);
		runCli(() => api.cli.restore.run([], {}));

		const sha2 = advanceChild(work, "tests", "v2");
		bumpPin(fresh, "tests", sha2);
		resetOutput();

		const code = runCli(() => api.cli.sync.run([], { dryRun: true }));
		expect(code).toBe(0);
		expect(logText()).toContain("would sync tests");
		expect(logText()).toContain("1 syncable, 0 unchanged, 0 left alone, 0 failed.");
		expect(git(["rev-parse", "HEAD"], path.join(fresh, "tests"))).toBe(childSha); // unmoved
	});

	it("reports in-sync (unchanged) when the child is already at the pin", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		process.chdir(fresh);
		runCli(() => api.cli.restore.run([], {}));
		resetOutput();

		const code = runCli(() => api.cli.sync.run([], {}));
		expect(code).toBe(0);
		expect(logText()).toContain("tests already at pin");
		expect(logText()).toContain("0 synced, 1 unchanged, 0 left alone, 0 failed.");
	});

	it("leaves a dirty child alone and counts it under 'left alone'", () => {
		const { work, parentBare, childSha } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		process.chdir(fresh);
		runCli(() => api.cli.restore.run([], {}));

		const sha2 = advanceChild(work, "tests", "v2");
		bumpPin(fresh, "tests", sha2);
		fs.writeFileSync(path.join(fresh, "tests", "uncommitted.txt"), "precious");
		resetOutput();

		const code = runCli(() => api.cli.sync.run([], {}));
		expect(code).toBe(0);
		expect(logText()).toContain("pin moved but child has uncommitted changes");
		expect(logText()).toContain("0 synced, 0 unchanged, 1 left alone, 0 failed.");
		expect(git(["rev-parse", "HEAD"], path.join(fresh, "tests"))).toBe(childSha); // unmoved
	});

	it("reports pin-unavailable as an error and exits 1 when the pin cannot be fetched", () => {
		const { work, parentBare, childSha } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		process.chdir(fresh);
		runCli(() => api.cli.restore.run([], {}));

		// A pin that exists nowhere the child can fetch from (never pushed).
		const ghostSha = advanceChild(work, "tests", "ghost", { push: false });
		bumpPin(fresh, "tests", ghostSha);
		resetOutput();

		const code = runCli(() => api.cli.sync.run([], {}));
		expect(code).toBe(1);
		expect(errText()).toContain("tests pin-unavailable");
		expect(errText()).toContain("not found at origin");
		expect(logText()).toContain("0 synced, 0 unchanged, 0 left alone, 1 failed.");
		expect(git(["rev-parse", "HEAD"], path.join(fresh, "tests"))).toBe(childSha); // unmoved
	});

	it("--skip (comma string) skips the child and counts it as skipped", () => {
		const { work, parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare);
		process.chdir(fresh);
		runCli(() => api.cli.restore.run([], {}));

		const sha2 = advanceChild(work, "tests", "v2");
		bumpPin(fresh, "tests", sha2); // there IS a move pending
		resetOutput();

		const code = runCli(() => api.cli.sync.run([], { skip: "tests" }));
		expect(code).toBe(0);
		expect(logText()).toContain("tests skipped");
		expect(logText()).toContain("0 synced, 0 unchanged, 0 left alone, 1 skipped, 0 failed.");
	});

	it("reports no-repo (warn) for an explicitly requested absent child", () => {
		const { parentBare } = makeParent({ gitlinkPath: "tests" });
		const fresh = freshClone(parentBare); // never restored
		process.chdir(fresh);

		const code = runCli(() => api.cli.sync.run(["tests"], {}));
		expect(code).toBe(0);
		expect(logText()).toContain("tests not present on disk — run restore");
		expect(logText()).toContain("0 synced, 0 unchanged, 0 left alone, 1 skipped, 0 failed.");
		expect(errText()).not.toContain("tests"); // no-repo is a warn, not an error
	});
});
