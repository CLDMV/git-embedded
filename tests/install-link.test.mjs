/**
 *	@Project: @cldmv/git-embedded
 *	@Filename: /tests/install-link.test.mjs
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 * Behavior tests for the install-dispatch + link-batch layer, driven through
 * the composed slothlet api against REAL files in temp dirs:
 *
 * - api.install.dispatcher (bootstrap|heal): writes hooks/_dispatch from the
 *   packaged template and fans out links to the standard hook names; heal only
 *   adds the missing ones without rewriting the dispatcher; unknown op throws.
 * - api.install.template: seeds a `git init` templateDir/hooks with the package
 *   hooks, honoring the foreign-hook skip and the --force override.
 * - api.link.batch: symlink (default) / hardlink (noSymlinks) mechanisms, the
 *   overwrite pre-removal, the copy fallback when a symlink can't be made, and
 *   the throw paths when no mechanism succeeds.
 * - api.link.copyExecutable: copy + +x bit, the overwrite pre-removal branch,
 *   and the overwrite:false branch.
 *
 * The Windows deferred-symlink → UAC-elevation path in link/batch.mjs is
 * guarded by `process.platform === "win32"` and is not reachable on POSIX CI;
 * it is not exercised here (see notes).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getApi } from "./_setup.mjs";

const isWin = process.platform === "win32";
const tmpRoots = [];

function mkTmp() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-embedded-instlink-"));
	tmpRoots.push(dir);
	return dir;
}

let originalEnv;

beforeEach(() => {
	originalEnv = { ...process.env };
	// Redirect the append-only transaction log into a throwaway state dir so the
	// install/heal ops here never touch the real ~/.local/state (or %LOCALAPPDATA%).
	const stateDir = mkTmp();
	process.env.XDG_STATE_HOME = stateDir;
	if (isWin) process.env.LOCALAPPDATA = stateDir;
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
const PACKAGE_HOOKS = ["post-checkout", "post-merge", "post-rewrite", "reference-transaction", "pre-push"];

function inode(p) {
	const st = fs.statSync(p);
	return `${st.dev}:${st.ino}`;
}

describe("api.install.dispatcher (bootstrap)", () => {
	it("writes _dispatch from the packaged template and links every standard hook name", () => {
		const dir = path.join(mkTmp(), "hooks-out"); // not-yet-existing → exercises mkdirSync
		const out = api.install.dispatcher("bootstrap", { dir });

		const dispatcherPath = path.join(dir, "_dispatch");
		expect(out.dispatcherPath).toBe(dispatcherPath);
		expect(fs.existsSync(dispatcherPath)).toBe(true);

		// Content came straight from hooks/_dispatch.template.
		const body = fs.readFileSync(dispatcherPath, "utf8");
		expect(body).toContain("git-embedded");
		expect(body).toContain("chain to the repository's own hook");

		// One created entry per standard hook name; none fell back to copy on POSIX.
		expect(out.created).toHaveLength(STANDARD_HOOK_NAMES.length);
		expect(out.created.map((c) => c.source).sort()).toEqual(STANDARD_HOOK_NAMES.map((n) => path.join(dir, n)).sort());
		for (const name of STANDARD_HOOK_NAMES) {
			expect(fs.existsSync(path.join(dir, name))).toBe(true);
		}
	});

	it.skipIf(isWin)("links the standard hooks as symlinks to _dispatch and marks _dispatch executable", () => {
		const dir = path.join(mkTmp(), "hooks-out");
		const out = api.install.dispatcher("bootstrap", { dir });
		const dispatcherPath = path.join(dir, "_dispatch");

		expect(out.fallbackToCopy).toEqual([]);
		expect(new Set(out.created.map((c) => c.mechanism))).toEqual(new Set(["symlink"]));

		// Each hook name is a symlink resolving to the dispatcher script.
		for (const name of STANDARD_HOOK_NAMES) {
			const p = path.join(dir, name);
			expect(fs.lstatSync(p).isSymbolicLink()).toBe(true);
			expect(fs.realpathSync(p)).toBe(fs.realpathSync(dispatcherPath));
		}
		// copyExecutable set the +x bit on the dispatcher.
		expect(fs.statSync(dispatcherPath).mode & 0o111).not.toBe(0);
	});

	it("with noSymlinks fans out hardlinks that share the dispatcher's inode", () => {
		const dir = path.join(mkTmp(), "hooks-out");
		const out = api.install.dispatcher("bootstrap", { dir }, { noSymlinks: true });
		const dispatcherPath = path.join(dir, "_dispatch");

		expect(out.fallbackToCopy).toEqual([]);
		expect(new Set(out.created.map((c) => c.mechanism))).toEqual(new Set(["hardlink"]));

		const dispatcherInode = inode(dispatcherPath);
		for (const name of STANDARD_HOOK_NAMES) {
			const p = path.join(dir, name);
			expect(fs.lstatSync(p).isSymbolicLink()).toBe(false);
			expect(inode(p)).toBe(dispatcherInode);
		}
	});

	it("honors a hookNames override, linking only the requested names", () => {
		const dir = path.join(mkTmp(), "hooks-out");
		const out = api.install.dispatcher("bootstrap", { dir }, { hookNames: ["pre-commit", "commit-msg"] });

		expect(out.created).toHaveLength(2);
		expect(out.created.map((c) => c.source).sort()).toEqual([path.join(dir, "commit-msg"), path.join(dir, "pre-commit")]);
		expect(fs.existsSync(path.join(dir, "pre-commit"))).toBe(true);
		expect(fs.existsSync(path.join(dir, "commit-msg"))).toBe(true);
		// A name outside the override was never linked.
		expect(fs.existsSync(path.join(dir, "post-checkout"))).toBe(false);
	});
});

describe("api.install.dispatcher (heal)", () => {
	it("adds only the missing entries and leaves the dispatcher script + existing links intact", () => {
		const dir = path.join(mkTmp(), "hooks-out");
		// Seed a partial dispatcher: _dispatch + a single pre-commit link.
		api.install.dispatcher("bootstrap", { dir }, { hookNames: ["pre-commit"] });
		const dispatcherPath = path.join(dir, "_dispatch");
		const dispatcherBefore = fs.readFileSync(dispatcherPath, "utf8");
		const preCommitBefore = fs.existsSync(path.join(dir, "pre-commit"));
		expect(preCommitBefore).toBe(true);

		const missing = ["post-checkout", "post-merge", "reference-transaction"];
		const out = api.install.dispatcher("heal", { dispatcherPath, missing });

		expect(out.created.map((c) => c.source).sort()).toEqual(missing.map((n) => path.join(dir, n)).sort());
		for (const name of missing) {
			const p = path.join(dir, name);
			expect(fs.existsSync(p)).toBe(true);
			if (!isWin) expect(fs.realpathSync(p)).toBe(fs.realpathSync(dispatcherPath));
		}
		// Heal never rewrites the dispatcher body, and pre-existing links survive.
		expect(fs.readFileSync(dispatcherPath, "utf8")).toBe(dispatcherBefore);
		expect(fs.existsSync(path.join(dir, "pre-commit"))).toBe(true);
	});

	it("is a no-op when there is nothing missing (undefined missing list)", () => {
		const dir = path.join(mkTmp(), "hooks-out");
		api.install.dispatcher("bootstrap", { dir }, { hookNames: ["pre-commit"] });
		const dispatcherPath = path.join(dir, "_dispatch");

		const out = api.install.dispatcher("heal", { dispatcherPath });
		expect(out.created).toEqual([]);
		expect(out.fallbackToCopy).toEqual([]);
	});
});

describe("api.install.dispatcher (guard)", () => {
	it("throws on an unknown op", () => {
		expect(() => api.install.dispatcher("frobnicate", {})).toThrow(/unknown op "frobnicate"/);
	});
});

describe("api.install.template", () => {
	it("seeds a git-init templateDir/hooks with the package hooks", () => {
		const templateDir = path.join(mkTmp(), "template"); // not-yet-existing → recursive mkdir
		const out = api.install.template(templateDir);

		const installed = Array.from(out.installed);
		for (const name of PACKAGE_HOOKS) expect(installed).toContain(name);
		expect(out.skipped).toEqual([]);

		const hooksDir = path.join(templateDir, "hooks");
		for (const name of PACKAGE_HOOKS) {
			const body = fs.readFileSync(path.join(hooksDir, name), "utf8");
			expect(body).toContain("git-embedded");
			if (!isWin) expect(fs.statSync(path.join(hooksDir, name)).mode & 0o111).not.toBe(0);
		}
	});

	it("skips a pre-existing foreign hook, then overwrites it under --force", () => {
		const templateDir = path.join(mkTmp(), "template");
		fs.mkdirSync(path.join(templateDir, "hooks"), { recursive: true });
		fs.writeFileSync(path.join(templateDir, "hooks", "pre-push"), "#!/bin/sh\necho foreign\n");

		const out = api.install.template(templateDir);
		// The foreign pre-push is refused; the other four still install.
		expect(Array.from(out.installed)).not.toContain("pre-push");
		const skipped = Array.from(out.skipped);
		expect(skipped.map((s) => s.name)).toContain("pre-push");
		expect(skipped.find((s) => s.name === "pre-push").reason).toMatch(/not owned by git-embedded/);
		// And its bytes are untouched.
		expect(fs.readFileSync(path.join(templateDir, "hooks", "pre-push"), "utf8")).toBe("#!/bin/sh\necho foreign\n");

		// --force flows through to install.hooks and overwrites the foreign file.
		const forced = api.install.template(templateDir, { force: true });
		expect(Array.from(forced.installed)).toContain("pre-push");
		expect(fs.readFileSync(path.join(templateDir, "hooks", "pre-push"), "utf8")).toContain("git-embedded");
	});

	it("re-installs its own (git-embedded-owned) hooks on a second run without skipping", () => {
		const templateDir = path.join(mkTmp(), "template");
		api.install.template(templateDir);
		const second = api.install.template(templateDir);
		// Owned hooks are recognized and overwritten, never skipped as foreign.
		expect(Array.from(second.installed).sort()).toEqual([...PACKAGE_HOOKS].sort());
		expect(second.skipped).toEqual([]);
	});
});

describe("api.link.batch", () => {
	// Build a real target file to link/copy from.
	function makeTarget(content = "#!/bin/sh\necho TARGET\n") {
		const t = path.join(mkTmp(), "target");
		fs.writeFileSync(t, content);
		return t;
	}

	it.skipIf(isWin)("creates a symlink per source (default mechanism) that resolves to the target", () => {
		const target = makeTarget();
		const base = mkTmp();
		// Sources live under a not-yet-existing subdir → exercises ensureDir.
		const sources = ["a", "b", "c"].map((n) => path.join(base, "nested", n));

		const out = api.link.batch(target, sources);

		expect(out.created.map((c) => c.source)).toEqual(sources);
		expect(new Set(out.created.map((c) => c.mechanism))).toEqual(new Set(["symlink"]));
		expect(out.fallbackToCopy).toEqual([]);
		for (const s of sources) {
			expect(fs.lstatSync(s).isSymbolicLink()).toBe(true);
			expect(fs.realpathSync(s)).toBe(fs.realpathSync(target));
			expect(fs.readFileSync(s, "utf8")).toBe("#!/bin/sh\necho TARGET\n");
		}
	});

	it("creates hardlinks under noSymlinks that share the target's inode", () => {
		const target = makeTarget();
		const base = mkTmp();
		const sources = ["a", "b"].map((n) => path.join(base, "nested", n));

		const out = api.link.batch(target, sources, { noSymlinks: true });

		expect(new Set(out.created.map((c) => c.mechanism))).toEqual(new Set(["hardlink"]));
		expect(out.fallbackToCopy).toEqual([]);
		for (const s of sources) {
			expect(fs.lstatSync(s).isSymbolicLink()).toBe(false);
			expect(inode(s)).toBe(inode(target));
		}
	});

	it("overwrite removes a pre-existing file at the source before linking", () => {
		const target = makeTarget("NEW-CONTENT\n");
		const source = path.join(mkTmp(), "slot");
		fs.writeFileSync(source, "STALE-CONTENT\n");
		const staleInode = inode(source);

		const out = api.link.batch(target, [source], { noSymlinks: true, overwrite: true });

		expect(out.created).toEqual([{ source, mechanism: "hardlink" }]);
		// The stale regular file was unlinked and replaced by a hardlink to target.
		expect(inode(source)).toBe(inode(target));
		expect(inode(source)).not.toBe(staleInode);
		expect(fs.readFileSync(source, "utf8")).toBe("NEW-CONTENT\n");
	});

	it.skipIf(isWin)("falls back to a copy when a symlink cannot be created (EEXIST, no overwrite)", () => {
		const target = makeTarget("COPIED-FROM-TARGET\n");
		const source = path.join(mkTmp(), "occupied");
		// A regular file already sits at the source and overwrite is false, so the
		// symlink attempt hits EEXIST → non-privilege, non-win32 → copy fallback.
		fs.writeFileSync(source, "was here first\n");

		const out = api.link.batch(target, [source]);

		expect(out.created).toEqual([{ source, mechanism: "copy" }]);
		expect(out.fallbackToCopy).toEqual([source]);
		expect(fs.lstatSync(source).isSymbolicLink()).toBe(false);
		// The target's bytes were copied over the occupant.
		expect(fs.readFileSync(source, "utf8")).toBe("COPIED-FROM-TARGET\n");
	});

	it("throws when neither a hardlink nor a copy can be created (missing target)", () => {
		const missingTarget = path.join(mkTmp(), "does-not-exist");
		const source = path.join(mkTmp(), "slot");

		expect(() => api.link.batch(missingTarget, [source], { noSymlinks: true })).toThrow();
		// Nothing was left behind at the source.
		expect(fs.existsSync(source)).toBe(false);
	});

	it.skipIf(isWin)("throws when a symlink fails and the copy fallback also fails (source is a directory)", () => {
		const target = makeTarget();
		const sourceDir = path.join(mkTmp(), "iam-a-dir");
		fs.mkdirSync(sourceDir);

		// symlink → EEXIST (dir present), copy → EISDIR: both fail, batch rethrows.
		expect(() => api.link.batch(target, [sourceDir])).toThrow();
		// The directory is left intact — the failed copy never clobbered it.
		expect(fs.statSync(sourceDir).isDirectory()).toBe(true);
	});

	it("returns empty results for an empty source list", () => {
		const target = makeTarget();
		const out = api.link.batch(target, []);
		expect(out).toEqual({ created: [], fallbackToCopy: [] });
	});
});

describe("api.link.copyExecutable", () => {
	function makeSource(content = "#!/bin/sh\necho hi\n") {
		const s = path.join(mkTmp(), "src");
		fs.writeFileSync(s, content);
		if (!isWin) fs.chmodSync(s, 0o644); // start non-executable so +x is provably added
		return s;
	}

	it("copies into a new dest and sets the executable bit on POSIX", () => {
		const source = makeSource();
		const dest = path.join(mkTmp(), "nested", "dest"); // dir absent → mkdirSync + lstat catch

		api.link.copyExecutable(source, dest);

		expect(fs.readFileSync(dest, "utf8")).toBe("#!/bin/sh\necho hi\n");
		if (!isWin) expect(fs.statSync(dest).mode & 0o111).toBe(0o111);
	});

	it("overwrite (default) removes and replaces an existing dest", () => {
		const source = makeSource("NEW\n");
		const dest = path.join(mkTmp(), "dest");
		fs.writeFileSync(dest, "OLD\n");

		api.link.copyExecutable(source, dest);
		expect(fs.readFileSync(dest, "utf8")).toBe("NEW\n");
	});

	it("overwrite:false skips the pre-removal but still copies the source over the dest", () => {
		const source = makeSource("NEWER\n");
		const dest = path.join(mkTmp(), "dest");
		fs.writeFileSync(dest, "OLDER\n");

		api.link.copyExecutable(source, dest, { overwrite: false });
		expect(fs.readFileSync(dest, "utf8")).toBe("NEWER\n");
	});
});
