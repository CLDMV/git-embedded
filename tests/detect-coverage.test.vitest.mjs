/**
 *	@Project: @cldmv/git-embedded
 *	@Filename: /tests/detect-coverage.test.vitest.mjs
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 * Targeted coverage-closing tests for src/api/detect/*. tests/detect-hooks.test.vitest.mjs,
 * tests/detect-foreign.test.vitest.mjs, and tests/dispatcher-classify.test.vitest.mjs cover the
 * baseline detection patterns; this file adds only the edge cases those don't
 * reach, closing dispatcher.mjs, husky.mjs, pre-commit.mjs, lefthook.mjs, and
 * run.mjs to 100% lines/statements/functions/branches:
 *
 * - src/api/detect/dispatcher.mjs — falsy `dir`, an unreadable dir, a
 *   directory-shaped `_dispatch` (readFileSync EISDIR), relative symlink
 *   targets, the copy-cluster hashing loop's skip/unreadable/losing-bucket
 *   branches, the all-different-content (no cluster) case, a dotted
 *   non-hook-only dir, a symlink pointing at an unrelated decoy file, and the
 *   TOCTOU-style fs-race branches (lstatSync/readlinkSync/statSync/
 *   realpathSync throwing after an earlier check already confirmed the path)
 *   simulated via targeted fs spies since a real filesystem race can't be
 *   fabricated deterministically.
 * - src/api/detect/husky.mjs — falsy repoRoot, a malformed package.json
 *   (wispSync throws), and the dependencies-only husky fallback.
 * - src/api/detect/pre-commit.mjs — falsy gitDir, a gitDir with no hooks
 *   subdir, and the readHead catch (a subdirectory entry in hooks/).
 * - src/api/detect/lefthook.mjs — the readHead catch (a subdirectory entry
 *   in hooks/).
 * - src/api/detect/run.mjs — the `effectiveHooksPath || systemPath`
 *   fallback, triggered by a cwd that doesn't exist on disk (so
 *   getEffectiveHooksPath's git spawn fails) while the system hooksPath
 *   scope is still readable (getAllHooksPathScopes ignores its cwd
 *   argument and reads from the real process cwd).
 *
 * Scratch fixtures live under this repo's tmp/ (never the system /tmp), are
 * tracked per-test, and are removed in afterEach/afterAll.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getApi } from "./_setup.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const scratchRoot = path.join(packageRoot, "tmp", "detect-coverage");
fs.mkdirSync(scratchRoot, { recursive: true });

const tmpRoots = [];
function mkTmp(prefix = "case-") {
	const dir = fs.mkdtempSync(path.join(scratchRoot, prefix));
	tmpRoots.push(dir);
	return dir;
}

function writeExecutable(p, body) {
	fs.writeFileSync(p, body);
	fs.chmodSync(p, 0o755);
}

function writeGitConfig(body) {
	const dir = mkTmp("cfg-");
	const f = path.join(dir, "config");
	fs.writeFileSync(f, body);
	return f;
}

// A chaining dispatcher body: the classifier recognizes the `exec "$repo_hook"`
// chain that marks a git-embedded-compatible dispatcher.
const CHAINING = `#!/bin/sh
# git-embedded-compatible dispatcher
hook=$(basename "$0")
git_dir=$(git rev-parse --absolute-git-dir 2>/dev/null) || exit 0
repo_hook="$git_dir/hooks/$hook"
if [ -x "$repo_hook" ] && [ "$repo_hook" != "$0" ]; then
    exec "$repo_hook" "$@"
fi
exit 0
`;

const REQUIRED_HOOKS = ["post-checkout", "post-merge", "post-rewrite", "reference-transaction"];

/** Identical CHAINING content at every required-hook name trips the
 * classifier's copy-cluster detection without needing symlink rights. */
function mkCanonicalHooksDir() {
	const dir = mkTmp("canonical-hooks-");
	for (const h of REQUIRED_HOOKS) writeExecutable(path.join(dir, h), CHAINING);
	return dir;
}

let originalEnv;
let originalCwd;
beforeEach(() => {
	originalEnv = { ...process.env };
	originalCwd = process.cwd();
	// Hermetic git: ignore host/global/system config, supply a commit identity.
	process.env.GIT_CONFIG_GLOBAL = os.platform() === "win32" ? "NUL" : "/dev/null";
	process.env.GIT_CONFIG_SYSTEM = os.platform() === "win32" ? "NUL" : "/dev/null";
	process.env.GIT_AUTHOR_NAME = "test";
	process.env.GIT_AUTHOR_EMAIL = "test@example.com";
	process.env.GIT_COMMITTER_NAME = "test";
	process.env.GIT_COMMITTER_EMAIL = "test@example.com";
});
afterEach(() => {
	vi.restoreAllMocks();
	try {
		process.chdir(originalCwd);
	} catch {
		// ignore
	}
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
afterAll(() => {
	try {
		fs.rmSync(scratchRoot, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

let api;
beforeAll(async () => {
	api = await getApi();
});

describe.skipIf(process.platform === "win32")("api.detect.dispatcher (remaining coverage gaps)", () => {
	it("returns empty for a falsy dir argument", () => {
		expect(api.detect.dispatcher(null)).toEqual({ kind: "empty" });
	});

	it("returns empty with a reason when the dir cannot be read (does not exist)", () => {
		const parent = mkTmp("parent-");
		const missing = path.join(parent, "does-not-exist");
		const out = api.detect.dispatcher(missing);
		expect(out.kind).toBe("empty");
		expect(out.reason).toBe("directory not readable");
	});

	it("classifies a directory-shaped _dispatch as non-conforming (readFileSync EISDIR)", () => {
		const dir = mkTmp("dispatch-is-dir-");
		fs.mkdirSync(path.join(dir, "_dispatch"));
		const out = api.detect.dispatcher(dir);
		expect(out.kind).toBe("dispatcher-non-conforming");
		expect(out.dispatcherPath).toBe(path.join(dir, "_dispatch"));
		expect(out.reason).toBe("dispatcher does not chain to per-repo hooks");
	});

	it("resolves relative symlink targets to a canonical-complete dispatcher", () => {
		const dir = mkTmp("relative-symlinks-");
		writeExecutable(path.join(dir, "_dispatch"), CHAINING);
		for (const hook of REQUIRED_HOOKS) {
			fs.symlinkSync("_dispatch", path.join(dir, hook)); // relative target, not absolute
		}
		const out = api.detect.dispatcher(dir);
		expect(out.kind).toBe("dispatcher-canonical-complete");
		expect(out.present.sort()).toEqual([...REQUIRED_HOOKS].sort());
	});

	it("finds a qualifying copy-cluster while skipping a non-standard name, an unreadable file, and a too-small rival bucket", () => {
		const dir = mkTmp("copy-cluster-");
		// Winning cluster: identical content at 3 real (non-symlink) files.
		writeExecutable(path.join(dir, "post-checkout"), CHAINING);
		writeExecutable(path.join(dir, "post-merge"), CHAINING);
		writeExecutable(path.join(dir, "post-rewrite"), CHAINING);
		// Rival, too-small (size 1) content bucket -- exercises the losing
		// `names.length >= 3` branch in the best-bucket selection.
		writeExecutable(path.join(dir, "commit-msg"), "#!/bin/sh\necho rival\n");
		// Unreadable standard-named file -- exercises the readFileSync catch
		// (continue) in the copy-cluster hashing loop.
		const unreadable = path.join(dir, "pre-push");
		writeExecutable(unreadable, "#!/bin/sh\necho unreadable\n");
		fs.chmodSync(unreadable, 0o000);
		// Non-standard name -- exercises the "skip non-hook names" continue.
		fs.writeFileSync(path.join(dir, "README.txt"), "not a hook\n");

		try {
			const out = api.detect.dispatcher(dir);
			expect(out.kind).toBe("dispatcher-missing-symlinks");
			expect(["post-checkout", "post-merge", "post-rewrite"]).toContain(path.basename(out.dispatcherPath));
			expect(out.present.sort()).toEqual(["post-checkout", "post-merge", "post-rewrite"]);
			expect(out.missing).toEqual(["reference-transaction"]);
		} finally {
			fs.chmodSync(unreadable, 0o755); // restore so afterEach cleanup can remove it
		}
	});

	it("finds no qualifying copy-cluster when all standard-named files differ -> bare-githooks", () => {
		const dir = mkTmp("no-cluster-");
		writeExecutable(path.join(dir, "post-checkout"), "#!/bin/sh\necho a\n");
		writeExecutable(path.join(dir, "post-merge"), "#!/bin/sh\necho b\n");
		writeExecutable(path.join(dir, "post-rewrite"), "#!/bin/sh\necho c\n");
		const out = api.detect.dispatcher(dir);
		expect(out.kind).toBe("bare-githooks");
	});

	it("returns empty when the only entries are non-hook, dotted names", () => {
		const dir = mkTmp("readme-only-");
		fs.writeFileSync(path.join(dir, "README.md"), "nothing to see here\n");
		const out = api.detect.dispatcher(dir);
		expect(out).toEqual({ kind: "empty" });
	});

	it("treats a symlink pointing at an unrelated decoy file as missing, not present", () => {
		const dir = mkTmp("decoy-symlink-");
		const dispatch = path.join(dir, "_dispatch");
		writeExecutable(dispatch, CHAINING);
		const decoy = path.join(dir, "_decoy");
		writeExecutable(decoy, "#!/bin/sh\necho decoy\n");
		fs.symlinkSync(dispatch, path.join(dir, "post-checkout"));
		fs.symlinkSync(dispatch, path.join(dir, "post-merge"));
		fs.symlinkSync(dispatch, path.join(dir, "post-rewrite"));
		fs.symlinkSync(decoy, path.join(dir, "reference-transaction"));
		const out = api.detect.dispatcher(dir);
		expect(out.kind).toBe("dispatcher-missing-symlinks");
		expect(out.present.sort()).toEqual(["post-checkout", "post-merge", "post-rewrite"]);
		expect(out.missing).toEqual(["reference-transaction"]);
	});

	it("still classifies canonical-complete via raw-path fallback when statSync/realpathSync race on the dispatcher itself", () => {
		const dir = mkTmp("dispatcher-stat-races-");
		const dispatch = path.join(dir, "_dispatch");
		writeExecutable(dispatch, CHAINING);
		for (const hook of REQUIRED_HOOKS) {
			fs.symlinkSync(dispatch, path.join(dir, hook)); // absolute target === dispatch
		}

		const realStat = fs.statSync.bind(fs);
		const realRealpath = fs.realpathSync.bind(fs);
		// Simulate the dispatcher file vanishing between the earlier
		// readFileSync (chain check) and these calls -- a TOCTOU race that
		// can't be fabricated deterministically on a real filesystem.
		vi.spyOn(fs, "statSync").mockImplementation((p, ...rest) => {
			if (p === dispatch) throw new Error("simulated ENOENT: statSync race on dispatcher");
			return realStat(p, ...rest);
		});
		vi.spyOn(fs, "realpathSync").mockImplementation((p, ...rest) => {
			if (p === dispatch) throw new Error("simulated ENOENT: realpathSync race on dispatcher");
			return realRealpath(p, ...rest);
		});

		const out = api.detect.dispatcher(dir);

		expect(out.kind).toBe("dispatcher-canonical-complete");
		expect(out.present.sort()).toEqual([...REQUIRED_HOOKS].sort());
	});

	it("keeps correct classification when lstatSync/readlinkSync race in the first inventory pass", () => {
		const dir = mkTmp("first-pass-races-");
		const dispatch = path.join(dir, "_dispatch");
		writeExecutable(dispatch, CHAINING);
		const raceLstatPath = path.join(dir, "post-rewrite");
		const raceReadlinkPath = path.join(dir, "post-merge");
		fs.symlinkSync(dispatch, path.join(dir, "post-checkout"));
		fs.symlinkSync(dispatch, raceReadlinkPath);
		fs.symlinkSync(dispatch, raceLstatPath);
		fs.symlinkSync(dispatch, path.join(dir, "reference-transaction"));

		const realLstat = fs.lstatSync.bind(fs);
		const realReadlink = fs.readlinkSync.bind(fs);
		// Simulate entries vanishing between readdirSync and the per-entry
		// lstat/readlink calls -- TOCTOU races that can't be fabricated
		// deterministically on a real filesystem.
		vi.spyOn(fs, "lstatSync").mockImplementation((p, ...rest) => {
			if (p === raceLstatPath) throw new Error("simulated ENOENT: lstatSync race");
			return realLstat(p, ...rest);
		});
		vi.spyOn(fs, "readlinkSync").mockImplementation((p, ...rest) => {
			if (p === raceReadlinkPath) throw new Error("simulated ENOENT: readlinkSync race");
			return realReadlink(p, ...rest);
		});

		const out = api.detect.dispatcher(dir);

		// post-rewrite: lost in the first pass (lstatSync raced) but still
		// resolves as present via the second pass's direct realpathSync check.
		// post-merge: readlinkSync raced -> recorded as an unresolved (null)
		// symlink target -> can't be confirmed present -> missing.
		expect(out.kind).toBe("dispatcher-missing-symlinks");
		expect(out.present.sort()).toEqual(["post-checkout", "post-rewrite", "reference-transaction"]);
		expect(out.missing).toEqual(["post-merge"]);
	});

	it("falls back to the raw path (and then to inode/copy-cluster checks) when realpathSync races on a plain-file required hook", () => {
		const dir = mkTmp("hook-realpath-races-");
		const dispatch = path.join(dir, "_dispatch");
		writeExecutable(dispatch, CHAINING);
		const decoyFile = path.join(dir, "post-checkout");
		writeExecutable(decoyFile, "#!/bin/sh\necho not-the-dispatcher\n");

		const realRealpath = fs.realpathSync.bind(fs);
		vi.spyOn(fs, "realpathSync").mockImplementation((p, ...rest) => {
			if (p === decoyFile) throw new Error("simulated ENOENT: realpathSync race on hook file");
			return realRealpath(p, ...rest);
		});

		const out = api.detect.dispatcher(dir);

		expect(out.kind).toBe("dispatcher-missing-symlinks");
		expect(out.present).toEqual([]);
		expect(out.missing.sort()).toEqual(["post-checkout", "post-merge", "post-rewrite", "reference-transaction"]);
	});
});

describe("api.detect.husky (remaining coverage gaps)", () => {
	it("returns null for a falsy repoRoot", () => {
		expect(api.detect.husky(null)).toBeNull();
	});

	it("swallows a malformed package.json (wispSync throws) and reports null prepare/version", () => {
		const root = mkTmp("husky-malformed-pkg-");
		fs.mkdirSync(path.join(root, ".husky"));
		fs.writeFileSync(path.join(root, "package.json"), "this is not valid json {");
		const out = api.detect.husky(root);
		expect(out).toEqual({ kind: "husky", dir: path.join(root, ".husky"), prepare: null, version: null });
	});

	it("falls back to dependencies.husky when devDependencies has no husky key", () => {
		const root = mkTmp("husky-deps-only-");
		fs.mkdirSync(path.join(root, ".husky"));
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { husky: "^8.0.0" } }));
		const out = api.detect.husky(root);
		expect(out.version).toBe("^8.0.0");
	});
});

describe("api.detect.preCommit (remaining coverage gaps)", () => {
	it("returns null when gitDir is falsy and there is no config file", () => {
		const root = mkTmp("precommit-no-gitdir-");
		expect(api.detect.preCommit(root, null)).toBeNull();
	});

	it("returns null when gitDir is set but has no hooks subdirectory", () => {
		const root = mkTmp("precommit-no-hooksdir-root-");
		const gitDir = mkTmp("precommit-no-hooksdir-gitdir-"); // no hooks/ subdir created
		expect(api.detect.preCommit(root, gitDir)).toBeNull();
	});

	it("exercises the readHead catch when the hooks dir contains only a subdirectory", () => {
		const root = mkTmp("precommit-subdir-only-root-");
		const gitDir = mkTmp("precommit-subdir-only-gitdir-");
		const hooksDir = path.join(gitDir, "hooks");
		fs.mkdirSync(hooksDir);
		fs.mkdirSync(path.join(hooksDir, "subdir")); // readFileSync on this throws (EISDIR)
		expect(api.detect.preCommit(root, gitDir)).toBeNull();
	});
});

describe("api.detect.lefthook (remaining coverage gaps)", () => {
	it("exercises the readHead catch when the hooks dir contains only a subdirectory", () => {
		const root = mkTmp("lefthook-subdir-only-root-");
		const gitDir = mkTmp("lefthook-subdir-only-gitdir-");
		const hooksDir = path.join(gitDir, "hooks");
		fs.mkdirSync(hooksDir);
		fs.mkdirSync(path.join(hooksDir, "subdir")); // readFileSync on this throws (EISDIR)
		expect(api.detect.lefthook(root, gitDir)).toBeNull();
	});
});

describe.skipIf(process.platform === "win32")("api.detect.run (remaining coverage gaps)", () => {
	it("falls back to systemPath when effectiveHooksPath resolution fails for a nonexistent cwd", () => {
		const hooksDir = mkCanonicalHooksDir();
		process.env.GIT_CONFIG_SYSTEM = writeGitConfig(`[core]\n\thooksPath = ${hooksDir}\n`);
		// getAllHooksPathScopes ignores its cwd argument and reads config from
		// the real process cwd, so chdir here to a real, existing non-repo dir
		// -- independent of the (nonexistent) cwd passed to detect.run below.
		const nonRepo = mkTmp("run-fallback-norepo-");
		process.chdir(nonRepo);
		// A cwd that was never created on disk: getEffectiveHooksPath's git
		// spawn fails (bad cwd for spawnSync) and returns null, forcing the
		// `effectiveHooksPath || systemPath` fallback to systemPath.
		const fakeCwd = path.join(nonRepo, "does-not-exist-at-all");
		const out = api.detect.run(fakeCwd);
		expect(out.paths.effectiveHooksPath).toBeNull();
		expect(out.kind).toBe("system-hookspath");
		expect(out.action).toBe("install");
		expect(out.subClassification.kind).toBe("dispatcher-canonical-complete");
	});
});
