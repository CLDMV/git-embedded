/**
 *	@Project: @cldmv/git-embedded
 *	@Filename: /tests/hook-guards.test.mjs
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 * Behavior tests for the two guard hooks, driven through REAL git operations
 * with the hooks installed into the parent's .git/hooks:
 *
 * - reference-transaction (embedded.guard = precise | strict | off): which
 *   HEAD moves are allowed/blocked given each child's dirty state and the
 *   pins in the NEW commit. Covers the plumbing fact that a plain commit
 *   emits a HEAD transaction line, the precise rule (dirty + would-re-pin),
 *   strict's all-clean + pins-current-on-append policy, and the drifted-child
 *   hole a naive pin-delta rule would miss.
 *
 * - pre-push (embedded.pushRecurse = check | on-demand | off): parent pushes
 *   are rejected while a newly-pinned child commit is unreachable from the
 *   child's origin, allowed once the child is pushed (on-demand publishes the
 *   child's branch to do that automatically), and unrelated (pin-less) pushes
 *   from a children-less clone stay allowed.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const hooksSrc = path.join(here, "..", "hooks");

const tmpRoots = [];
function mkTmp() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-embedded-guards-"));
	tmpRoots.push(dir);
	return dir;
}

function git(args, cwd) {
	const res = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (res.status !== 0) throw new Error(`git ${args.join(" ")} (cwd=${cwd}) failed: ${res.stderr || res.stdout}`);
	return (res.stdout || "").trim();
}

/** Like git() but returns { status, stderr } for operations expected to be blocked. */
function gitTry(args, cwd) {
	const res = spawnSync("git", args, { cwd, encoding: "utf8" });
	return { status: res.status ?? 1, stderr: res.stderr || "", stdout: res.stdout || "" };
}

function installHook(repoDir, name) {
	const dest = path.join(repoDir, ".git", "hooks", name);
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.copyFileSync(path.join(hooksSrc, name), dest);
	fs.chmodSync(dest, 0o755);
}

/**
 * Parent repo with one embedded child at `tests`, pushed bares for both, and
 * the requested hooks installed. Child working copy inside the parent is a
 * clone of the child bare (origin wired), attached to main at c1.
 */
function makeGuardedParent({ hooks = [], childPath = "tests" } = {}) {
	const work = mkTmp();
	const childBare = path.join(work, "child.git");
	git(["init", "--bare", "-b", "main", childBare]);
	const childSeed = path.join(work, "child-seed");
	git(["init", "-b", "main", childSeed]);
	fs.writeFileSync(path.join(childSeed, "spec.txt"), "c1");
	git(["add", "."], childSeed);
	git(["commit", "-m", "c1"], childSeed);
	git(["remote", "add", "origin", childBare], childSeed);
	git(["push", "--quiet", "origin", "main"], childSeed);

	const parentBare = path.join(work, "parent.git");
	git(["init", "--bare", "-b", "main", parentBare]);
	const parent = path.join(work, "parent");
	git(["init", "-b", "main", parent]);
	fs.writeFileSync(path.join(parent, "README.md"), "parent");
	git(["add", "."], parent);
	git(["commit", "-m", "parent init"], parent);
	git(["clone", "--quiet", childBare, path.join(parent, childPath)], parent);
	git(["add", childPath], parent);
	git(["commit", "-m", `embed ${childPath}`], parent);
	git(["remote", "add", "origin", parentBare], parent);

	for (const h of hooks) installHook(parent, h);
	const child = path.join(parent, childPath);
	return { work, parent, parentBare, child, childBare, childPath };
}

/** Commit inside the child (advances its HEAD; keeps it clean). */
function childCommit(child, marker) {
	fs.writeFileSync(path.join(child, "spec.txt"), marker);
	git(["add", "."], child);
	git(["commit", "-m", marker], child);
	return git(["rev-parse", "HEAD"], child);
}

// "Dirty" per the hooks' diff-index semantics = a MODIFIED TRACKED file.
// (Untracked files never count — same as the original guard's behavior.)
function dirtyChild(child) {
	fs.writeFileSync(path.join(child, "spec.txt"), "UNCOMMITTED EDIT");
}
function cleanChild(child) {
	git(["checkout", "--", "spec.txt"], child);
}

let originalEnv;
beforeEach(() => {
	originalEnv = { ...process.env };
	// Hermetic git: no host/global config (no global hooksPath dispatcher, no
	// signing), a fixed identity.
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
			/* ignore */
		}
	}
});

describe.skipIf(process.platform === "win32")("reference-transaction guard modes", () => {
	it("precise (default): a parent commit passes while a child is dirty AT its pin", () => {
		const { parent, child } = makeGuardedParent({ hooks: ["reference-transaction"] });
		dirtyChild(child);
		fs.writeFileSync(path.join(parent, "README.md"), "v2");
		git(["add", "README.md"], parent);
		git(["commit", "-m", "docs"], parent); // would throw if blocked
		expect(git(["log", "--oneline", "-1"], parent)).toContain("docs");
	});

	it("precise: a checkout that would re-pin a dirty child is blocked; the same checkout with the child clean passes", () => {
		const { parent, child } = makeGuardedParent({ hooks: ["reference-transaction"] });
		const commitA = git(["rev-parse", "HEAD"], parent);
		const c2 = childCommit(child, "c2");
		git(["add", "tests"], parent);
		git(["commit", "-m", "bump pin to c2"], parent);

		dirtyChild(child); // child HEAD c2; commitA pins c1 → re-pin + dirty
		const blocked = gitTry(["checkout", "--quiet", commitA], parent);
		expect(blocked.status).not.toBe(0);
		expect(blocked.stderr).toMatch(/would re-pin/);
		expect(git(["rev-parse", "HEAD"], child)).toBe(c2); // untouched

		cleanChild(child);
		const ok = gitTry(["checkout", "--quiet", commitA], parent);
		expect(ok.status).toBe(0);
	});

	it("precise: a checkout whose pin equals the dirty child's HEAD passes (sync would no-op)", () => {
		const { parent, child } = makeGuardedParent({ hooks: ["reference-transaction"] });
		fs.writeFileSync(path.join(parent, "README.md"), "v2");
		git(["add", "README.md"], parent);
		git(["commit", "-m", "docs only"], parent); // same pin as previous commit
		dirtyChild(child); // child at c1 == pin in BOTH commits
		const ok = gitTry(["checkout", "--quiet", "HEAD~1"], parent);
		expect(ok.status).toBe(0);
	});

	it("precise: catches the DRIFTED dirty child even when the pin is unchanged across the move", () => {
		const { parent, child } = makeGuardedParent({ hooks: ["reference-transaction"] });
		fs.writeFileSync(path.join(parent, "README.md"), "v2");
		git(["add", "README.md"], parent);
		git(["commit", "-m", "docs only"], parent); // pin still c1 in both commits
		childCommit(child, "c2"); // drift: child HEAD c2, pin (both commits) c1
		dirtyChild(child);
		// pin-delta between the two parent commits is ZERO — a naive rule allows
		// this; the sync would still try to move the dirty child back to c1.
		const blocked = gitTry(["checkout", "--quiet", "HEAD~1"], parent);
		expect(blocked.status).not.toBe(0);
		expect(blocked.stderr).toMatch(/would re-pin/);
	});

	it("strict: any dirty child blocks a parent commit", () => {
		const { parent, child } = makeGuardedParent({ hooks: ["reference-transaction"] });
		git(["config", "--local", "embedded.guard", "strict"], parent);
		dirtyChild(child);
		fs.writeFileSync(path.join(parent, "README.md"), "v2");
		git(["add", "README.md"], parent);
		const blocked = gitTry(["commit", "-m", "docs"], parent);
		expect(blocked.status).not.toBe(0);
		expect(blocked.stderr).toMatch(/uncommitted changes/);
	});

	it("strict: a clean child with a STALE pin blocks a parent commit until the pin is recorded", () => {
		const { parent, child } = makeGuardedParent({ hooks: ["reference-transaction"] });
		git(["config", "--local", "embedded.guard", "strict"], parent);
		childCommit(child, "c2"); // clean, but pin (c1) is now stale
		fs.writeFileSync(path.join(parent, "README.md"), "v2");
		git(["add", "README.md"], parent);
		const blocked = gitTry(["commit", "-m", "docs without pin bump"], parent);
		expect(blocked.status).not.toBe(0);
		expect(blocked.stderr).toMatch(/not synced/);

		git(["add", "tests"], parent); // record the pin → now current
		git(["commit", "-m", "docs + pin bump"], parent);
		expect(git(["log", "--oneline", "-1"], parent)).toContain("pin bump");
	});

	it("strict: a jump (checkout) with all children clean passes even though pins differ", () => {
		const { parent, child } = makeGuardedParent({ hooks: ["reference-transaction"] });
		const commitA = git(["rev-parse", "HEAD"], parent);
		childCommit(child, "c2");
		git(["add", "tests"], parent);
		git(["commit", "-m", "bump"], parent);
		git(["config", "--local", "embedded.guard", "strict"], parent);
		// commitA pins c1, child HEAD is c2 — clean, and a checkout is a jump,
		// so the pins-current rule does not apply.
		const ok = gitTry(["checkout", "--quiet", commitA], parent);
		expect(ok.status).toBe(0);
	});

	it("off: dirty + drifted child blocks nothing", () => {
		const { parent, child } = makeGuardedParent({ hooks: ["reference-transaction"] });
		git(["config", "--local", "embedded.guard", "off"], parent);
		childCommit(child, "c2");
		dirtyChild(child);
		fs.writeFileSync(path.join(parent, "README.md"), "v2");
		git(["add", "README.md"], parent);
		git(["commit", "-m", "docs"], parent);
		const ok = gitTry(["checkout", "--quiet", "HEAD~1"], parent);
		expect(ok.status).toBe(0);
	});

	it("precise: a spaced-path child that is dirty and would be re-pinned is blocked", () => {
		const { parent, child } = makeGuardedParent({ hooks: ["reference-transaction"], childPath: "my tests" });
		const commitA = git(["rev-parse", "HEAD"], parent);
		childCommit(child, "c2");
		git(["add", "my tests"], parent);
		git(["commit", "-m", "bump pin to c2"], parent);
		dirtyChild(child); // child at c2; commitA pins c1 → re-pin + dirty
		const blocked = gitTry(["checkout", "--quiet", commitA], parent);
		expect(blocked.status).not.toBe(0);
		expect(blocked.stderr).toMatch(/would re-pin/);
		expect(blocked.stderr).toContain("my tests"); // full path, not split on the space
	});
});

describe.skipIf(process.platform === "win32")("pre-push pin-publication check", () => {
	it("check (default): pushing a parent whose new pin IS on the child's origin passes", () => {
		const { parent } = makeGuardedParent({ hooks: ["pre-push"] });
		git(["push", "--quiet", "origin", "main"], parent); // initial: pin c1 is on child origin
		expect(git(["ls-remote", "origin", "main"], parent)).not.toBe("");
	});

	it("check: a parent pinning a committed-but-UNPUSHED child commit is rejected, then passes after the child pushes", () => {
		const { parent, child } = makeGuardedParent({ hooks: ["pre-push"] });
		git(["push", "--quiet", "origin", "main"], parent);

		childCommit(child, "c2"); // NOT pushed to child origin
		git(["add", "tests"], parent);
		git(["commit", "-m", "bump pin to unpublished c2"], parent);

		const blocked = gitTry(["push", "--quiet", "origin", "main"], parent);
		expect(blocked.status).not.toBe(0);
		expect(blocked.stderr).toMatch(/not on that child's origin/);

		git(["push", "--quiet", "origin", "main"], child); // publish the child
		git(["push", "--quiet", "origin", "main"], parent); // now passes
		const remoteTip = git(["ls-remote", "origin", "main"], parent).split(/\s/)[0];
		expect(remoteTip).toBe(git(["rev-parse", "HEAD"], parent));
	});

	it("off: the same unpublished pin pushes without verification", () => {
		const { parent, child } = makeGuardedParent({ hooks: ["pre-push"] });
		git(["config", "--local", "embedded.pushRecurse", "off"], parent);
		git(["push", "--quiet", "origin", "main"], parent);
		childCommit(child, "c2");
		git(["add", "tests"], parent);
		git(["commit", "-m", "bump"], parent);
		git(["push", "--quiet", "origin", "main"], parent); // would throw if blocked
	});

	it("a clone WITHOUT restored children can push commits that touch no pin", () => {
		const { parent, parentBare } = makeGuardedParent({ hooks: [] });
		git(["push", "--quiet", "origin", "main"], parent);
		const bareClone = path.join(mkTmp(), "clone");
		git(["clone", "--quiet", parentBare, bareClone]);
		installHook(bareClone, "pre-push"); // gitlink dir is empty — no child repo
		fs.writeFileSync(path.join(bareClone, "README.md"), "docs from machine B");
		git(["add", "README.md"], bareClone);
		git(["commit", "-m", "docs"], bareClone);
		git(["push", "--quiet", "origin", "main"], bareClone); // would throw if blocked
	});

	it("a pin CHANGE for a child that is not present locally is rejected (cannot verify)", () => {
		const { parent, parentBare, child } = makeGuardedParent({ hooks: [] });
		git(["push", "--quiet", "origin", "main"], parent);
		const c2 = childCommit(child, "c2");
		git(["push", "--quiet", "origin", "main"], child); // even published — can't VERIFY locally
		const bareClone = path.join(mkTmp(), "clone");
		git(["clone", "--quiet", parentBare, bareClone]);
		installHook(bareClone, "pre-push");
		// Hand-craft a pin bump without a child repo present.
		git(["update-index", "--add", "--cacheinfo", `160000,${c2},tests`], bareClone);
		git(["commit", "-m", "blind pin bump"], bareClone);
		const blocked = gitTry(["push", "--quiet", "origin", "main"], bareClone);
		expect(blocked.status).not.toBe(0);
		expect(blocked.stderr).toMatch(/not present/);
	});

	it("on-demand: an unpublished pin is auto-published by pushing the child branch, then the parent push passes", () => {
		const { parent, child } = makeGuardedParent({ hooks: ["pre-push"] });
		git(["config", "--local", "embedded.pushRecurse", "on-demand"], parent);
		git(["push", "--quiet", "origin", "main"], parent); // initial: pin c1 already published

		const c2 = childCommit(child, "c2"); // committed but NOT pushed to the child's origin
		git(["add", "tests"], parent);
		git(["commit", "-m", "bump pin to c2 (unpublished)"], parent);

		// on-demand publishes the child's current branch (main, which contains c2)
		// as a side effect, so the parent push is then allowed.
		git(["push", "--quiet", "origin", "main"], parent); // would throw if blocked

		// The child's c2 was pushed to its origin by the hook.
		expect(git(["ls-remote", "origin", "main"], child).split(/\s/)[0]).toBe(c2);
		// And the parent push landed.
		expect(git(["ls-remote", "origin", "main"], parent).split(/\s/)[0]).toBe(git(["rev-parse", "HEAD"], parent));
	});

	it("check: a child whose gitlink path contains spaces is verified correctly (published pin passes)", () => {
		const { parent } = makeGuardedParent({ hooks: ["pre-push"], childPath: "my tests" });
		// Pin c1 is already on the child's origin. The old path-first serialization
		// misparsed "my tests" into path "my" and wrongly rejected this push.
		git(["push", "--quiet", "origin", "main"], parent); // would throw if blocked
		expect(git(["ls-remote", "origin", "main"], parent)).not.toBe("");
	});

	it("check: an unpublished pin for a spaced-path child is rejected naming the full path", () => {
		const { parent, child } = makeGuardedParent({ hooks: ["pre-push"], childPath: "my tests" });
		git(["push", "--quiet", "origin", "main"], parent);
		childCommit(child, "c2"); // committed, NOT pushed to the child's origin
		git(["add", "my tests"], parent);
		git(["commit", "-m", "bump pin to unpublished c2"], parent);
		const blocked = gitTry(["push", "--quiet", "origin", "main"], parent);
		expect(blocked.status).not.toBe(0);
		// Old bug: misparsed to path "my" → "not present"; fixed: real path + cause.
		expect(blocked.stderr).toMatch(/not on that child's origin/);
		expect(blocked.stderr).toContain("my tests");
	});
});
