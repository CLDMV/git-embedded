/**
 *	@Project: @cldmv/git-embedded
 *	@Filename: /tests/detect-hooks.test.vitest.mjs
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 * Coverage tests for the hook-manager detectors and the detect orchestrator:
 *
 * - src/api/detect/lefthook.mjs        — config-name variants, the gitDir
 *   hooks-header scan (headerIn), and the null/no-match branches.
 * - src/api/detect/pre-commit.mjs      — the gitDir hooks-header scan and the
 *   null/no-match branches.
 * - src/api/detect/simple-git-hooks.mjs — the package.json key path (with its
 *   parsed config), the standalone `.simple-git-hooks.json` path, and the
 *   wispSync-throws → pkg=null branch.
 * - src/api/detect/run.mjs             — the whole classifier: foreign-manager
 *   precedence (husky > lefthook > simple-git-hooks > pre-commit), effective
 *   core.hooksPath sub-classification (canonical / missing / non-conforming /
 *   bare / empty), system-scope hooksPath, init.templateDir fallback, and none.
 *
 * The detectors are pure-fs and are driven directly with fabricated
 * repoRoot/gitDir args (matching tests/detect-foreign.test.vitest.mjs). run() shells
 * out to real git, so it is driven against real temp repos with a hermetic git
 * environment (matching tests/embedded-provisioning.test.vitest.mjs).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getApi } from "./_setup.mjs";

const tmpRoots = [];
function mkTmp(prefix = "git-embedded-detect-") {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tmpRoots.push(dir);
	return dir;
}

function git(args, cwd) {
	const res = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (res.status !== 0) throw new Error(`git ${args.join(" ")} (cwd=${cwd}) failed: ${res.stderr || res.stdout}`);
	return (res.stdout || "").trim();
}

/** git init a fresh repo in a temp dir and return its worktree path. */
function mkGitRepo() {
	const dir = mkTmp("git-embedded-repo-");
	git(["init", "-b", "main"], dir);
	return dir;
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

// A dispatcher body that never chains to a per-repo hook → non-conforming.
const NONCHAINING = `#!/bin/sh
hook=$(basename "$0")
echo "non-conforming dispatcher for $hook"
exit 0
`;

const REQUIRED_HOOKS = ["post-checkout", "post-merge", "post-rewrite", "reference-transaction"];

function writeExecutable(p, body) {
	fs.writeFileSync(p, body);
	fs.chmodSync(p, 0o755);
}

/**
 * A hooks dir that classifies canonical-complete WITHOUT needing symlink
 * rights: identical copies of the chaining body at every required-hook name
 * trip the classifier's copy-cluster detection.
 */
function mkCanonicalHooksDir() {
	const dir = mkTmp("git-embedded-hooks-");
	for (const h of REQUIRED_HOOKS) writeExecutable(path.join(dir, h), CHAINING);
	return dir;
}

/** Only 3 of the 4 required hooks present → dispatcher-missing-symlinks. */
function mkMissingHooksDir() {
	const dir = mkTmp("git-embedded-hooks-");
	for (const h of ["post-checkout", "post-merge", "post-rewrite"]) writeExecutable(path.join(dir, h), CHAINING);
	return dir;
}

/** A lone `_dispatch` that does not chain → dispatcher-non-conforming. */
function mkNonConformingHooksDir() {
	const dir = mkTmp("git-embedded-hooks-");
	writeExecutable(path.join(dir, "_dispatch"), NONCHAINING);
	return dir;
}

/** A single ordinary hook script, no dispatcher → bare-githooks. */
function mkBareHooksDir() {
	const dir = mkTmp("git-embedded-hooks-");
	writeExecutable(path.join(dir, "pre-commit"), "#!/bin/sh\necho hi\n");
	return dir;
}

/** Write a git config file (for GIT_CONFIG_SYSTEM / GIT_CONFIG_GLOBAL). */
function writeGitConfig(body) {
	const dir = mkTmp("git-embedded-cfg-");
	const f = path.join(dir, "config");
	fs.writeFileSync(f, body);
	return f;
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

let api;
beforeAll(async () => {
	api = await getApi();
});

describe("api.detect.lefthook (edge cases)", () => {
	it("returns null for a falsy repoRoot", () => {
		expect(api.detect.lefthook(null, null)).toBeNull();
	});

	it("detects a non-primary config-name variant (.lefthook.yaml)", () => {
		const root = mkTmp();
		fs.writeFileSync(path.join(root, ".lefthook.yaml"), "pre-commit:\n  commands: {}\n");
		const out = api.detect.lefthook(root, null);
		expect(out).not.toBeNull();
		expect(out.kind).toBe("lefthook");
		expect(out.configFile.endsWith(".lefthook.yaml")).toBe(true);
	});

	it("finds a lefthook header inside a gitDir hook when no config file exists", () => {
		const root = mkTmp(); // no lefthook config here
		const gitDir = mkTmp("git-embedded-gitdir-");
		const hooksDir = path.join(gitDir, "hooks");
		fs.mkdirSync(hooksDir);
		// A subdir exercises readHead's catch (readFileSync on a dir throws).
		fs.mkdirSync(path.join(hooksDir, "subdir"));
		// A non-matching sibling exercises the head-does-not-match continue.
		fs.writeFileSync(path.join(hooksDir, "commit-msg"), "#!/bin/sh\necho unrelated\n");
		fs.writeFileSync(path.join(hooksDir, "pre-commit"), "#!/bin/sh\n# generated by lefthook\nlefthook run pre-commit\n");

		const out = api.detect.lefthook(root, gitDir);
		expect(out).not.toBeNull();
		expect(out.kind).toBe("lefthook");
		expect(out.configFile).toBeNull();
		expect(out.headerIn).toBe(path.join(hooksDir, "pre-commit"));
	});

	it("returns null when the gitDir has a hooks dir but no lefthook header", () => {
		const root = mkTmp();
		const gitDir = mkTmp("git-embedded-gitdir-");
		fs.mkdirSync(path.join(gitDir, "hooks"));
		fs.writeFileSync(path.join(gitDir, "hooks", "pre-commit"), "#!/bin/sh\necho plain\n");
		expect(api.detect.lefthook(root, gitDir)).toBeNull();
	});

	it("returns null when neither a config nor a gitDir hooks dir is present", () => {
		const root = mkTmp(); // no config
		const gitDir = mkTmp("git-embedded-gitdir-"); // no hooks/ subdir
		expect(api.detect.lefthook(root, gitDir)).toBeNull();
		// And with no gitDir at all.
		expect(api.detect.lefthook(root, null)).toBeNull();
	});
});

describe("api.detect.preCommit (edge cases)", () => {
	it("returns null for a falsy repoRoot", () => {
		expect(api.detect.preCommit(null, null)).toBeNull();
	});

	it("finds a pre-commit generated-header inside a gitDir hook when no config file exists", () => {
		const root = mkTmp(); // no .pre-commit-config.yaml
		const gitDir = mkTmp("git-embedded-gitdir-");
		const hooksDir = path.join(gitDir, "hooks");
		fs.mkdirSync(hooksDir);
		fs.mkdirSync(path.join(hooksDir, "subdir")); // readHead catch
		fs.writeFileSync(path.join(hooksDir, "commit-msg"), "#!/bin/sh\necho unrelated\n");
		fs.writeFileSync(path.join(hooksDir, "pre-commit"), "#!/usr/bin/env bash\n# File generated by pre-commit: https://pre-commit.com\n");

		const out = api.detect.preCommit(root, gitDir);
		expect(out).not.toBeNull();
		expect(out.kind).toBe("pre-commit");
		expect(out.configFile).toBeNull();
		expect(out.headerIn).toBe(path.join(hooksDir, "pre-commit"));
	});

	it("returns null when the gitDir hooks dir has no pre-commit header", () => {
		const root = mkTmp();
		const gitDir = mkTmp("git-embedded-gitdir-");
		fs.mkdirSync(path.join(gitDir, "hooks"));
		fs.writeFileSync(path.join(gitDir, "hooks", "pre-commit"), "#!/bin/sh\necho plain\n");
		expect(api.detect.preCommit(root, gitDir)).toBeNull();
	});
});

describe("api.detect.simpleGitHooks (edge cases)", () => {
	it("returns null for a falsy repoRoot", () => {
		expect(api.detect.simpleGitHooks(null)).toBeNull();
	});

	it("returns the parsed config from a package.json top-level key", () => {
		const root = mkTmp();
		const cfg = { "pre-commit": "echo hi", "pre-push": "echo bye" };
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ "simple-git-hooks": cfg }));
		const out = api.detect.simpleGitHooks(root);
		expect(out).not.toBeNull();
		expect(out.kind).toBe("simple-git-hooks");
		expect(out.configIn).toBe("package.json");
		expect(out.config).toEqual(cfg);
	});

	it("detects a standalone .simple-git-hooks.json when there is no package.json", () => {
		const root = mkTmp();
		const standalone = path.join(root, ".simple-git-hooks.json");
		fs.writeFileSync(standalone, JSON.stringify({ "pre-commit": "echo standalone" }));
		const out = api.detect.simpleGitHooks(root);
		expect(out).not.toBeNull();
		expect(out.kind).toBe("simple-git-hooks");
		expect(out.configIn).toBe(standalone);
	});

	it("swallows a malformed package.json (wispSync throws) and falls back to the standalone file", () => {
		const root = mkTmp();
		fs.writeFileSync(path.join(root, "package.json"), "this is not valid json {");
		const standalone = path.join(root, ".simple-git-hooks.json");
		fs.writeFileSync(standalone, JSON.stringify({ "pre-commit": "echo x" }));
		const out = api.detect.simpleGitHooks(root);
		expect(out).not.toBeNull();
		expect(out.configIn).toBe(standalone);
	});

	it("returns null when a package.json has no key and there is no standalone file", () => {
		const root = mkTmp();
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "no-hooks-here" }));
		expect(api.detect.simpleGitHooks(root)).toBeNull();
	});

	it("returns null when a malformed package.json has no standalone fallback", () => {
		const root = mkTmp();
		fs.writeFileSync(path.join(root, "package.json"), "not json");
		expect(api.detect.simpleGitHooks(root)).toBeNull();
	});
});

describe.skipIf(process.platform === "win32")("api.detect.run (foreign-manager precedence)", () => {
	it("classifies husky (highest precedence) and refuses", () => {
		const repo = mkGitRepo();
		fs.mkdirSync(path.join(repo, ".husky"));
		fs.writeFileSync(
			path.join(repo, "package.json"),
			JSON.stringify({ scripts: { prepare: "husky" }, devDependencies: { husky: "^9.0.0" } })
		);
		const out = api.detect.run(repo);
		expect(out.kind).toBe("husky");
		expect(out.action).toBe("refuse");
		expect(out.foreign.kind).toBe("husky");
	});

	it("classifies lefthook and refuses", () => {
		const repo = mkGitRepo();
		fs.writeFileSync(path.join(repo, "lefthook.yml"), "pre-commit:\n  commands: {}\n");
		const out = api.detect.run(repo);
		expect(out.kind).toBe("lefthook");
		expect(out.action).toBe("refuse");
		expect(out.foreign.configFile.endsWith("lefthook.yml")).toBe(true);
	});

	it("classifies simple-git-hooks and refuses", () => {
		const repo = mkGitRepo();
		fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ "simple-git-hooks": { "pre-commit": "echo hi" } }));
		const out = api.detect.run(repo);
		expect(out.kind).toBe("simple-git-hooks");
		expect(out.action).toBe("refuse");
		expect(out.foreign.configIn).toBe("package.json");
	});

	it("classifies pre-commit and refuses", () => {
		const repo = mkGitRepo();
		fs.writeFileSync(path.join(repo, ".pre-commit-config.yaml"), "repos: []\n");
		const out = api.detect.run(repo);
		expect(out.kind).toBe("pre-commit");
		expect(out.action).toBe("refuse");
		expect(out.foreign.configFile.endsWith(".pre-commit-config.yaml")).toBe(true);
	});
});

describe.skipIf(process.platform === "win32")("api.detect.run (effective core.hooksPath classification)", () => {
	function repoWithHooksPath(hooksDir) {
		const repo = mkGitRepo();
		git(["config", "--local", "core.hooksPath", hooksDir], repo);
		return repo;
	}

	it("routes a canonical-complete dispatcher to action install", () => {
		const repo = repoWithHooksPath(mkCanonicalHooksDir());
		const out = api.detect.run(repo);
		expect(out.kind).toBe("dispatcher-canonical-complete");
		expect(out.action).toBe("install");
		expect(out.dispatcher.kind).toBe("dispatcher-canonical-complete");
	});

	it("routes a missing-symlinks dispatcher to action heal-then-install", () => {
		const repo = repoWithHooksPath(mkMissingHooksDir());
		const out = api.detect.run(repo);
		expect(out.kind).toBe("dispatcher-missing-symlinks");
		expect(out.action).toBe("heal-then-install");
		expect(Array.from(out.dispatcher.missing)).toContain("reference-transaction");
	});

	it("routes a non-conforming dispatcher to action refuse", () => {
		const repo = repoWithHooksPath(mkNonConformingHooksDir());
		const out = api.detect.run(repo);
		expect(out.kind).toBe("dispatcher-non-conforming");
		expect(out.action).toBe("refuse");
	});

	it("routes a bare githooks dir to action refuse", () => {
		const repo = repoWithHooksPath(mkBareHooksDir());
		const out = api.detect.run(repo);
		expect(out.kind).toBe("bare-githooks");
		expect(out.action).toBe("refuse");
		expect(out.bare.kind).toBe("bare-githooks");
	});

	it("falls through to none when the hooksPath dir is empty", () => {
		const repo = repoWithHooksPath(mkTmp("git-embedded-hooks-empty-"));
		const out = api.detect.run(repo);
		expect(out.kind).toBe("none");
		expect(out.action).toBe("suggest-dispatcher");
	});
});

describe.skipIf(process.platform === "win32")("api.detect.run (fallbacks)", () => {
	it("reports none for a plain repo with no manager, hooksPath, or template dir", () => {
		const repo = mkGitRepo();
		const out = api.detect.run(repo);
		expect(out.kind).toBe("none");
		expect(out.action).toBe("suggest-dispatcher");
		expect(out.paths.repoRoot).toBe(git(["rev-parse", "--show-toplevel"], repo));
	});

	it("reports init-templatedir when a global init.templateDir with a hooks dir exists", () => {
		const repo = mkGitRepo();
		const tmplDir = mkTmp("git-embedded-tmpl-");
		fs.mkdirSync(path.join(tmplDir, "hooks"));
		process.env.GIT_CONFIG_GLOBAL = writeGitConfig(`[init]\n\ttemplateDir = ${tmplDir}\n`);
		const out = api.detect.run(repo);
		expect(out.kind).toBe("init-templatedir");
		expect(out.action).toBe("suggest-dispatcher");
		expect(out.templateDir).toBe(tmplDir);
	});

	it("reports system-hookspath install for a system-scope core.hooksPath to a canonical dispatcher", () => {
		const hooksDir = mkCanonicalHooksDir();
		process.env.GIT_CONFIG_SYSTEM = writeGitConfig(`[core]\n\thooksPath = ${hooksDir}\n`);
		// A non-repo cwd keeps the local scope empty so the system-only branch fires.
		const nonRepo = mkTmp("git-embedded-norepo-");
		process.chdir(nonRepo);
		const out = api.detect.run(nonRepo);
		expect(out.kind).toBe("system-hookspath");
		expect(out.action).toBe("install");
		expect(out.subClassification.kind).toBe("dispatcher-canonical-complete");
		expect(out.dispatcher.kind).toBe("dispatcher-canonical-complete");
	});

	it("reports system-hookspath refuse (dispatcher null) for a system-scope hooksPath to a bare dir", () => {
		const hooksDir = mkBareHooksDir();
		process.env.GIT_CONFIG_SYSTEM = writeGitConfig(`[core]\n\thooksPath = ${hooksDir}\n`);
		const nonRepo = mkTmp("git-embedded-norepo-");
		process.chdir(nonRepo);
		const out = api.detect.run(nonRepo);
		expect(out.kind).toBe("system-hookspath");
		expect(out.action).toBe("refuse");
		expect(out.subClassification.kind).toBe("bare-githooks");
		expect(out.dispatcher).toBeNull();
	});
});
