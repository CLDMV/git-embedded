/**
 *	@Project: @cldmv/git-embedded
 *	@Filename: /tests/link-coverage.test.vitest.mjs
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 * Coverage-completing behavior tests for the link + install-hooks layer,
 * complementing tests/install-link.test.vitest.mjs and tests/install-hooks.test.vitest.mjs.
 * Everything here is driven through the composed slothlet api against REAL
 * files in temp dirs; the branches that only fire on Windows (privilege-denied
 * symlink → UAC batch) or on a copy/chmod failure are exercised by:
 *
 * - Pinning `process.platform` to "win32" for the duration of a single
 *   synchronous `api.link.batch` call, then restoring it.
 * - Injecting controlled failures into the fs primitives the leaf calls
 *   (`symlinkSync`, `linkSync`, `chmodSync`) — the leaf reads them off the
 *   shared node:fs object at call time, so a temporary property swap makes the
 *   documented fallback/branch fire without needing a real cross-volume mount
 *   or a real UAC prompt.
 * - Overriding `api.link.elevateWindows` (the Windows-only helper is excluded
 *   from coverage and cannot run on POSIX) with a stub that returns each of the
 *   result shapes the batch caller must handle: cancelled, failed, succeeded.
 *
 * All stubs are restored in a finally before any assertion runs, so a failed
 * expectation can never leave process.platform or fs mutated for later tests.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getApi } from "./_setup.mjs";

const isWin = process.platform === "win32";
const tmpRoots = [];

// Keep every throwaway dir inside the repo's gitignored tmp/ rather than the
// system /tmp, per the project scratch convention.
const repoTmp = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "tmp");
fs.mkdirSync(repoTmp, { recursive: true });

function mkTmp() {
	const dir = fs.mkdtempSync(path.join(repoTmp, "git-embedded-linkcov-"));
	tmpRoots.push(dir);
	return dir;
}

function makeTarget(content = "#!/bin/sh\necho TARGET\n") {
	const t = path.join(mkTmp(), "target");
	fs.writeFileSync(t, content);
	return t;
}

function inode(p) {
	const st = fs.statSync(p);
	return `${st.dev}:${st.ino}`;
}

// --- stub helpers (each returns a restore fn) ---------------------------------

function stubPlatform(value) {
	const orig = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value, configurable: true });
	return () => Object.defineProperty(process, "platform", orig);
}

function patchFs(overrides) {
	const saved = {};
	for (const k of Object.keys(overrides)) {
		saved[k] = fs[k];
		fs[k] = overrides[k];
	}
	return () => {
		for (const k of Object.keys(saved)) fs[k] = saved[k];
	};
}

function stubElevate(api, fn) {
	const orig = api.link.elevateWindows;
	api.link.elevateWindows = fn;
	return () => {
		api.link.elevateWindows = orig;
	};
}

/**
 * Run a synchronous batch() call with process.platform pinned to "win32" and
 * optional fs / elevateWindows stubs, restoring everything before returning so
 * an assertion on the captured result/error cannot leak stub state.
 */
function withWin32(api, { fs: fsOverrides, elevate } = {}, call) {
	const restorePlatform = stubPlatform("win32");
	const restoreFs = fsOverrides ? patchFs(fsOverrides) : () => {};
	const restoreElevate = elevate ? stubElevate(api, elevate) : () => {};
	let result;
	let error;
	try {
		try {
			result = call();
		} catch (e) {
			error = e;
		}
	} finally {
		restoreElevate();
		restoreFs();
		restorePlatform();
	}
	return { result, error };
}

let originalEnv;
beforeEach(() => {
	originalEnv = { ...process.env };
	// Redirect the append-only transaction log into a throwaway state dir so the
	// install/uninstall ops here never touch the real ~/.local/state.
	const stateDir = mkTmp();
	process.env.XDG_STATE_HOME = stateDir;
	if (isWin) process.env.LOCALAPPDATA = stateDir;
});

afterEach(() => {
	process.env = originalEnv;
	while (tmpRoots.length) {
		const d = tmpRoots.pop();
		try {
			fs.chmodSync(d, 0o755);
		} catch {
			// ignore
		}
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

// =============================================================================
// api.link.batch — POSIX base mechanisms (self-contained: no reliance on the
// sibling install-link suite for these lines).
// =============================================================================
describe("api.link.batch base mechanisms", () => {
	it.skipIf(isWin)("creates a symlink per source that resolves to the target", () => {
		const target = makeTarget();
		const base = mkTmp();
		const sources = ["a", "b"].map((n) => path.join(base, "nested", n));

		const out = api.link.batch(target, sources);

		expect(new Set(out.created.map((c) => c.mechanism))).toEqual(new Set(["symlink"]));
		expect(out.fallbackToCopy).toEqual([]);
		for (const s of sources) {
			expect(fs.lstatSync(s).isSymbolicLink()).toBe(true);
			expect(fs.realpathSync(s)).toBe(fs.realpathSync(target));
		}
	});

	it("creates hardlinks under noSymlinks that share the target's inode", () => {
		const target = makeTarget();
		const source = path.join(mkTmp(), "nested", "hl");

		const out = api.link.batch(target, [source], { noSymlinks: true });

		expect(out.created).toEqual([{ source, mechanism: "hardlink" }]);
		expect(inode(source)).toBe(inode(target));
	});

	it("overwrite removes a pre-existing file before hardlinking (removeIfExists true branch)", () => {
		const target = makeTarget("NEW\n");
		const source = path.join(mkTmp(), "slot");
		fs.writeFileSync(source, "STALE\n");
		const staleInode = inode(source);

		const out = api.link.batch(target, [source], { noSymlinks: true, overwrite: true });

		expect(out.created).toEqual([{ source, mechanism: "hardlink" }]);
		expect(inode(source)).toBe(inode(target));
		expect(inode(source)).not.toBe(staleInode);
	});

	it("overwrite on a not-yet-existing source is a no-op removal (removeIfExists false branch)", () => {
		const target = makeTarget();
		const source = path.join(mkTmp(), "fresh"); // nothing to remove
		const out = api.link.batch(target, [source], { noSymlinks: true, overwrite: true });
		expect(out.created).toEqual([{ source, mechanism: "hardlink" }]);
		expect(inode(source)).toBe(inode(target));
	});

	it.skipIf(isWin)("overwrite removes a pre-existing file before symlinking (symlink-path removeIfExists)", () => {
		const target = makeTarget("FRESH\n");
		const source = path.join(mkTmp(), "slot");
		fs.writeFileSync(source, "STALE\n"); // exercises the overwrite branch in the symlink loop
		const out = api.link.batch(target, [source], { overwrite: true });
		expect(out.created).toEqual([{ source, mechanism: "symlink" }]);
		expect(fs.lstatSync(source).isSymbolicLink()).toBe(true);
		expect(fs.readFileSync(source, "utf8")).toBe("FRESH\n");
	});
});

// =============================================================================
// api.link.batch — copy fallbacks (POSIX), driven by injecting fs failures.
// =============================================================================
describe("api.link.batch copy fallbacks", () => {
	it("noSymlinks: falls back to copy (with +x) when the hardlink fails", () => {
		const target = makeTarget("COPIED\n");
		const source = path.join(mkTmp(), "sub", "cp");
		// linkSync fails as if cross-device; copyFileSync stays real and succeeds.
		const restore = patchFs({
			linkSync: () => {
				const e = new Error("cross-device link not permitted");
				e.code = "EXDEV";
				throw e;
			}
		});
		let out;
		try {
			out = api.link.batch(target, [source], { noSymlinks: true });
		} finally {
			restore();
		}
		expect(out.created).toEqual([{ source, mechanism: "copy" }]);
		expect(out.fallbackToCopy).toEqual([source]);
		expect(fs.readFileSync(source, "utf8")).toBe("COPIED\n");
		if (!isWin) expect(fs.statSync(source).mode & 0o111).not.toBe(0);
	});

	it("noSymlinks: copy still succeeds when the best-effort chmod throws", () => {
		const target = makeTarget("CHMODLESS\n");
		const source = path.join(mkTmp(), "sub", "cp2");
		const restore = patchFs({
			linkSync: () => {
				const e = new Error("no hardlink");
				e.code = "EXDEV";
				throw e;
			},
			chmodSync: () => {
				const e = new Error("chmod denied");
				e.code = "EPERM";
				throw e;
			}
		});
		let out;
		try {
			out = api.link.batch(target, [source], { noSymlinks: true });
		} finally {
			restore();
		}
		// chmod failure is swallowed (best-effort); the copy still counts.
		expect(out.created).toEqual([{ source, mechanism: "copy" }]);
		expect(fs.readFileSync(source, "utf8")).toBe("CHMODLESS\n");
	});

	it("noSymlinks: throws the copy error when neither hardlink nor copy can be made", () => {
		const source = path.join(mkTmp(), "slot");
		const restore = patchFs({
			linkSync: () => {
				const e = new Error("no hardlink");
				e.code = "EXDEV";
				throw e;
			},
			copyFileSync: () => {
				const e = new Error("no copy either");
				e.code = "ENOSPC";
				throw e;
			}
		});
		let err;
		try {
			try {
				api.link.batch(makeTarget(), [source], { noSymlinks: true });
			} catch (e) {
				err = e;
			}
		} finally {
			restore();
		}
		// slothlet re-wraps a leaf throw as a SlothletError, embedding the original
		// message — assert on that rather than the (now-wrapped) .code.
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toMatch(/no copy either/);
		expect(fs.existsSync(source)).toBe(false);
	});

	it("symlink: non-privilege failure (non-win32) falls back to copy", () => {
		const target = makeTarget("SYM-COPY\n");
		const source = path.join(mkTmp(), "sub", "occupied");
		const restore = patchFs({
			symlinkSync: () => {
				const e = new Error("already exists");
				e.code = "EEXIST";
				throw e;
			}
		});
		let out;
		try {
			out = api.link.batch(target, [source]); // default = symlink
		} finally {
			restore();
		}
		expect(out.created).toEqual([{ source, mechanism: "copy" }]);
		expect(out.fallbackToCopy).toEqual([source]);
		expect(fs.readFileSync(source, "utf8")).toBe("SYM-COPY\n");
	});

	it("symlink: rethrows the symlink error when the copy fallback also fails", () => {
		const source = path.join(mkTmp(), "sub", "occupied");
		const restore = patchFs({
			symlinkSync: () => {
				const e = new Error("symlink boom");
				e.code = "EEXIST";
				throw e;
			},
			copyFileSync: () => {
				const e = new Error("copy boom");
				e.code = "EISDIR";
				throw e;
			}
		});
		let err;
		try {
			try {
				api.link.batch(makeTarget(), [source]);
			} catch (e) {
				err = e;
			}
		} finally {
			restore();
		}
		// The SYMLINK error is what surfaces (ln.error), not the copy error.
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toMatch(/symlink boom/);
		expect(err.message).not.toMatch(/copy boom/);
	});
});

// =============================================================================
// api.link.batch — Windows privilege-denied → deferred → elevateWindows.
// Exercised on POSIX by pinning process.platform and stubbing the helper.
// =============================================================================
describe("api.link.batch windows elevation path", () => {
	// One error per source name so a single call drives every isPrivilegeError
	// branch: EPERM (WIN_PRIV_NOT_HELD), EACCES, and errno === -4048.
	const privSymlink = (_target, source) => {
		const e = new Error("privilege not held");
		if (source.endsWith("-eperm")) e.code = "EPERM";
		else if (source.endsWith("-eacces")) e.code = "EACCES";
		else {
			e.code = "UNKNOWN";
			e.errno = -4048;
		}
		throw e;
	};

	it("defers every privilege-denied symlink and marks them symlink-elevated on success", () => {
		const target = makeTarget();
		const base = mkTmp();
		const sources = ["s-eperm", "s-eacces", "s-errno"].map((n) => path.join(base, n));
		let receivedPlan = null;

		const { result, error } = withWin32(
			api,
			{
				fs: { symlinkSync: privSymlink },
				elevate: (plan) => {
					receivedPlan = plan;
					return { ok: true, cancelled: false, exitCode: 0 };
				}
			},
			() => api.link.batch(target, sources)
		);

		expect(error).toBeUndefined();
		expect(result.created).toEqual(sources.map((source) => ({ source, mechanism: "symlink-elevated" })));
		expect(result.fallbackToCopy).toEqual([]);
		// The helper received the full {source,target} plan for the deferred set.
		expect(receivedPlan).toEqual(sources.map((source) => ({ source, target })));
	});

	it("throws CancelledByUser when the UAC prompt is cancelled (with helper message)", () => {
		const target = makeTarget();
		const source = path.join(mkTmp(), "s-eperm");

		const { error } = withWin32(
			api,
			{
				fs: { symlinkSync: privSymlink },
				elevate: () => ({ ok: false, cancelled: true, message: "UAC elevation cancelled by user" })
			},
			() => api.link.batch(target, [source])
		);

		// The leaf throws CancelledByUser (its constructor runs); slothlet re-wraps
		// it, so the distinguishing signal available here is the embedded message.
		expect(error).toBeDefined();
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toMatch(/UAC elevation cancelled by user/);
	});

	it("throws CancelledByUser with a default message when the helper omits one", () => {
		const target = makeTarget();
		const source = path.join(mkTmp(), "s-eacces");

		const { error } = withWin32(
			api,
			{
				fs: { symlinkSync: privSymlink },
				elevate: () => ({ ok: false, cancelled: true })
			},
			() => api.link.batch(target, [source])
		);

		expect(error).toBeDefined();
		// The default (helper supplied no message): "UAC elevation cancelled",
		// distinct from the "…cancelled by user" message the helper can pass.
		expect(error.message).toContain("UAC elevation cancelled");
		expect(error.message).not.toContain("by user");
	});

	it("throws the helper's message when elevation fails (not cancelled)", () => {
		const target = makeTarget();
		const source = path.join(mkTmp(), "s-eperm");

		const { error } = withWin32(
			api,
			{
				fs: { symlinkSync: privSymlink },
				elevate: () => ({ ok: false, cancelled: false, exitCode: 2, message: "powershell blew up" })
			},
			() => api.link.batch(target, [source])
		);

		expect(error).toBeInstanceOf(Error);
		expect(error.message).toMatch(/powershell blew up/);
	});

	it("throws a synthesized exit-code message when elevation fails without a message", () => {
		const target = makeTarget();
		const source = path.join(mkTmp(), "s-eperm");

		const { error } = withWin32(
			api,
			{
				fs: { symlinkSync: privSymlink },
				elevate: () => ({ ok: false, cancelled: false, exitCode: 7 })
			},
			() => api.link.batch(target, [source])
		);

		expect(error).toBeInstanceOf(Error);
		expect(error.message).toMatch(/elevated symlink batch failed \(exit 7\)/);
	});

	it("on win32, a NON-privilege symlink failure copies instead of deferring", () => {
		const target = makeTarget("WIN-COPY\n");
		const source = path.join(mkTmp(), "sub", "plain");
		let elevateCalled = false;

		const { result, error } = withWin32(
			api,
			{
				fs: {
					symlinkSync: () => {
						const e = new Error("not a privilege problem");
						e.code = "EEXIST";
						e.errno = -17;
						throw e;
					}
				},
				elevate: () => {
					elevateCalled = true;
					return { ok: true, cancelled: false, exitCode: 0 };
				}
			},
			() => api.link.batch(target, [source])
		);

		expect(error).toBeUndefined();
		expect(result.created).toEqual([{ source, mechanism: "copy" }]);
		expect(result.fallbackToCopy).toEqual([source]);
		expect(elevateCalled).toBe(false); // deferred set was empty → helper never invoked
		// copyFileSync ran; on win32 the +x chmod is skipped (branch under test).
		expect(fs.readFileSync(source, "utf8")).toBe("WIN-COPY\n");
	});

	it("on win32, a symlink that throws a falsy error is treated as non-privilege (copies)", () => {
		const target = makeTarget("FALSY\n");
		const source = path.join(mkTmp(), "sub", "falsy");

		const { result, error } = withWin32(
			api,
			{
				fs: {
					symlinkSync: () => {
						throw undefined;
					}
				},
				elevate: () => ({ ok: true, cancelled: false, exitCode: 0 })
			},
			() => api.link.batch(target, [source])
		);

		expect(error).toBeUndefined();
		expect(result.created).toEqual([{ source, mechanism: "copy" }]);
		expect(fs.readFileSync(source, "utf8")).toBe("FALSY\n");
	});

	it("returns empty results for an empty source list", () => {
		const out = api.link.batch(makeTarget(), []);
		expect(out).toEqual({ created: [], fallbackToCopy: [] });
	});
});

// =============================================================================
// api.link.copyExecutable — the win32 branch (chmod skipped) plus overwrite arms.
// =============================================================================
describe("api.link.copyExecutable", () => {
	function makeSource(content = "#!/bin/sh\necho hi\n") {
		const s = path.join(mkTmp(), "src");
		fs.writeFileSync(s, content);
		if (!isWin) fs.chmodSync(s, 0o644);
		return s;
	}

	it("copies into a new dest and sets +x on POSIX (default overwrite, nothing to remove)", () => {
		const source = makeSource();
		const dest = path.join(mkTmp(), "nested", "dest");
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

	it("overwrite:false skips pre-removal but still copies over the dest", () => {
		const source = makeSource("NEWER\n");
		const dest = path.join(mkTmp(), "dest");
		fs.writeFileSync(dest, "OLDER\n");
		api.link.copyExecutable(source, dest, { overwrite: false });
		expect(fs.readFileSync(dest, "utf8")).toBe("NEWER\n");
	});

	it("on win32 the +x chmod is skipped (copy only)", () => {
		const source = makeSource("WINEXE\n");
		const dest = path.join(mkTmp(), "dest");
		const restorePlatform = stubPlatform("win32");
		try {
			api.link.copyExecutable(source, dest, { overwrite: true });
		} finally {
			restorePlatform();
		}
		expect(fs.readFileSync(dest, "utf8")).toBe("WINEXE\n");
	});
});

// =============================================================================
// api.install.hooks — the three uncovered arms: unknown op, unreadable dest on
// install (existing = "") and on uninstall (body = ""), and the uninstall
// "kept foreign package hook" branch.
// =============================================================================
describe("api.install.hooks coverage completion", () => {
	const FOREIGN_PACKAGE_HOOK = "post-checkout"; // a name in PACKAGE_HOOK_MAP

	it("throws on an unknown op", async () => {
		await expect(async () => api.install.hooks("frobnicate", mkTmp())).rejects.toThrow(/unknown op "frobnicate"/);
	});

	it("install: skips a dest whose bytes cannot be read (readFileSync throws → treated as foreign)", async () => {
		const gitDir = mkTmp();
		const hooksDir = path.join(gitDir, "hooks");
		fs.mkdirSync(hooksDir, { recursive: true });
		// A directory sitting where the hook file would be: existsSync() is true,
		// but readFileSync() throws EISDIR → the catch sets existing = "".
		fs.mkdirSync(path.join(hooksDir, FOREIGN_PACKAGE_HOOK));

		const out = await api.install.hooks("install", gitDir);

		const skipped = Array.from(out.skipped).map((s) => s.name);
		expect(skipped).toContain(FOREIGN_PACKAGE_HOOK);
		expect(Array.from(out.installed)).not.toContain(FOREIGN_PACKAGE_HOOK);
		// The unreadable dest was left untouched.
		expect(fs.statSync(path.join(hooksDir, FOREIGN_PACKAGE_HOOK)).isDirectory()).toBe(true);
	});

	it("install: --force overwrites a foreign (readable) hook", async () => {
		const gitDir = mkTmp();
		const hooksDir = path.join(gitDir, "hooks");
		fs.mkdirSync(hooksDir, { recursive: true });
		fs.writeFileSync(path.join(hooksDir, FOREIGN_PACKAGE_HOOK), "#!/bin/sh\n# not ours\n");

		const out = await api.install.hooks("install", gitDir, { force: true });

		expect(Array.from(out.installed)).toContain(FOREIGN_PACKAGE_HOOK);
		expect(fs.readFileSync(path.join(hooksDir, FOREIGN_PACKAGE_HOOK), "utf8")).toContain("git-embedded");
	});

	it("install: re-installs its own hooks on a second run (owned dest, not skipped)", async () => {
		const gitDir = mkTmp();
		await api.install.hooks("install", gitDir);
		const out = await api.install.hooks("install", gitDir);
		expect(Array.from(out.skipped)).toEqual([]);
		expect(Array.from(out.installed)).toContain(FOREIGN_PACKAGE_HOOK);
	});

	it("uninstall: removes only the git-embedded-owned hooks", async () => {
		const gitDir = mkTmp();
		await api.install.hooks("install", gitDir);
		const out = await api.install.hooks("uninstall", gitDir);
		const removed = Array.from(out.removed);
		for (const name of ["post-checkout", "post-merge", "post-rewrite", "reference-transaction", "pre-push"]) {
			expect(removed).toContain(name);
			expect(fs.existsSync(path.join(gitDir, "hooks", name))).toBe(false);
		}
	});

	it("uninstall: is a no-op for hooks that do not exist", async () => {
		const gitDir = mkTmp(); // no hooks dir at all → every dest is absent
		const out = await api.install.hooks("uninstall", gitDir);
		expect(Array.from(out.removed)).toEqual([]);
		expect(Array.from(out.kept)).toEqual([]);
	});

	it("uninstall: keeps a foreign package-named hook (body does not include git-embedded)", async () => {
		const gitDir = mkTmp();
		const hooksDir = path.join(gitDir, "hooks");
		fs.mkdirSync(hooksDir, { recursive: true });
		fs.writeFileSync(path.join(hooksDir, FOREIGN_PACKAGE_HOOK), "#!/bin/sh\necho someone-else\n");

		const out = await api.install.hooks("uninstall", gitDir);

		const kept = Array.from(out.kept).map((k) => k.name);
		expect(kept).toContain(FOREIGN_PACKAGE_HOOK);
		expect(Array.from(out.removed)).not.toContain(FOREIGN_PACKAGE_HOOK);
		// Left in place, bytes intact.
		expect(fs.readFileSync(path.join(hooksDir, FOREIGN_PACKAGE_HOOK), "utf8")).toBe("#!/bin/sh\necho someone-else\n");
	});

	it("uninstall: keeps a dest whose bytes cannot be read (readFileSync throws → body = '')", async () => {
		const gitDir = mkTmp();
		const hooksDir = path.join(gitDir, "hooks");
		fs.mkdirSync(hooksDir, { recursive: true });
		// Directory where a hook would be → existsSync true, readFileSync throws.
		fs.mkdirSync(path.join(hooksDir, FOREIGN_PACKAGE_HOOK));

		const out = await api.install.hooks("uninstall", gitDir);

		const kept = Array.from(out.kept).map((k) => k.name);
		expect(kept).toContain(FOREIGN_PACKAGE_HOOK);
		expect(fs.statSync(path.join(hooksDir, FOREIGN_PACKAGE_HOOK)).isDirectory()).toBe(true);
	});
});
