import { self, context } from "@cldmv/slothlet/runtime";

const WIN_PRIV_NOT_HELD = "EPERM";

export class CancelledByUser extends Error {
	constructor(message) {
		super(message);
		this.name = "CancelledByUser";
	}
}

function removeIfExists(p) {
	const { fs } = context;
	try {
		fs.lstatSync(p);
	} catch {
		return false;
	}
	fs.unlinkSync(p);
	return true;
}

function isPrivilegeError(err) {
	if (!err) return false;
	if (err.code === WIN_PRIV_NOT_HELD || err.code === "EACCES") return true;
	if (typeof err.errno === "number" && err.errno === -4048) return true;
	return false;
}

function trySymlink(source, target) {
	try {
		context.fs.symlinkSync(target, source, "file");
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err };
	}
}

function tryHardlink(source, target) {
	try {
		context.fs.linkSync(target, source);
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err };
	}
}

function tryCopy(source, target) {
	const { fs } = context;
	try {
		fs.copyFileSync(target, source);
		if (process.platform !== "win32") {
			try {
				const st = fs.statSync(source);
				fs.chmodSync(source, st.mode | 0o111);
			} catch {
				// best-effort
			}
		}
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err };
	}
}

/**
 * Create links from many sources to one target. Default mechanism is symlink;
 * `opts.noSymlinks` switches to hardlink (falling back to copy on cross-volume
 * or non-NTFS). On Windows, missing symlink privilege triggers a single UAC
 * batch via `self.link.elevateWindows`.
 *
 * @param {string} target absolute path of the file being linked-to
 * @param {string[]} sources absolute paths of the new links to create
 * @param {object} [opts]
 * @param {boolean} [opts.noSymlinks]
 * @param {boolean} [opts.overwrite]
 */
export default function batch(target, sources, opts = {}) {
	const { noSymlinks = false, overwrite = false } = opts;
	const { fs, path } = context;
	const created = [];
	const fallbackToCopy = [];

	const ensureDir = (p) => fs.mkdirSync(path.dirname(p), { recursive: true });

	if (noSymlinks) {
		for (const source of sources) {
			ensureDir(source);
			if (overwrite) removeIfExists(source);
			const hl = tryHardlink(source, target);
			if (hl.ok) {
				created.push({ source, mechanism: "hardlink" });
				continue;
			}
			const cp = tryCopy(source, target);
			if (!cp.ok) throw cp.error;
			created.push({ source, mechanism: "copy" });
			fallbackToCopy.push(source);
		}
		return { created, fallbackToCopy };
	}

	const deferred = [];
	for (const source of sources) {
		ensureDir(source);
		if (overwrite) removeIfExists(source);
		const ln = trySymlink(source, target);
		if (ln.ok) {
			created.push({ source, mechanism: "symlink" });
			continue;
		}
		if (process.platform === "win32" && isPrivilegeError(ln.error)) {
			deferred.push(source);
			continue;
		}
		const cp = tryCopy(source, target);
		if (!cp.ok) throw ln.error;
		created.push({ source, mechanism: "copy" });
		fallbackToCopy.push(source);
	}

	if (deferred.length > 0) {
		const result = self.link.elevateWindows(deferred.map((source) => ({ source, target })));
		if (result.cancelled) throw new CancelledByUser(result.message || "UAC elevation cancelled");
		if (!result.ok) throw new Error(result.message || `elevated symlink batch failed (exit ${result.exitCode})`);
		for (const source of deferred) created.push({ source, mechanism: "symlink-elevated" });
	}

	return { created, fallbackToCopy };
}
