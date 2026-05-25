import { self, context } from "@cldmv/slothlet/runtime";
import { STANDARD_HOOK_NAMES } from "../detect/dispatcher.mjs";

/**
 * Install or heal a canonical dispatcher.
 *
 * `op === "bootstrap"` writes `hooks/_dispatch.template` into the target
 * directory and links every standard hook name to it. `op === "heal"` only
 * adds missing entries, leaving the existing dispatcher script alone.
 *
 * @param {"bootstrap"|"heal"} op
 * @param {object} target
 * @param {string} [target.dir] destination directory (for bootstrap)
 * @param {string} [target.dispatcherPath] existing dispatcher path (for heal)
 * @param {string[]} [target.missing] hook names to add (for heal)
 * @param {object} [opts]
 * @param {boolean} [opts.noSymlinks]
 * @param {string[]} [opts.hookNames] override for bootstrap (defaults to all standard hook names)
 */
export default function dispatcher(op, target, opts = {}) {
	if (op === "bootstrap") return bootstrap(target.dir, opts);
	if (op === "heal") return heal(target.dispatcherPath, target.missing, opts);
	throw new Error(`install.dispatcher: unknown op "${op}" (expected "bootstrap" or "heal")`);
}

function bootstrap(dir, { noSymlinks = false, hookNames = STANDARD_HOOK_NAMES } = {}) {
	const { fs, path } = context;
	fs.mkdirSync(dir, { recursive: true });
	const source = path.join(self.paths.hooksSourceDir(), "_dispatch.template");
	const dest = path.join(dir, "_dispatch");
	self.link.copyExecutable(source, dest, { overwrite: true });
	self.log.append({ op: "install-dispatcher", path: dest });

	const sources = hookNames.map((n) => path.join(dir, n));
	const result = self.link.batch(dest, sources, { noSymlinks, overwrite: true });
	for (const entry of result.created) {
		self.log.append({ op: "install-dispatcher-link", path: entry.source, mechanism: entry.mechanism, target: dest });
	}
	return { dispatcherPath: dest, created: result.created, fallbackToCopy: result.fallbackToCopy };
}

function heal(dispatcherPath, missing, { noSymlinks = false } = {}) {
	const { path } = context;
	const dir = path.dirname(dispatcherPath);
	const sources = (missing || []).map((n) => path.join(dir, n));
	const result = self.link.batch(dispatcherPath, sources, { noSymlinks, overwrite: false });
	for (const entry of result.created) {
		self.log.append({ op: "heal-dispatcher-link", path: entry.source, mechanism: entry.mechanism, target: dispatcherPath });
	}
	return result;
}
