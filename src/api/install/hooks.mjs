import { self, context } from "@cldmv/slothlet/runtime";

export const PACKAGE_HOOK_MAP = {
	"post-checkout": "update-embedded-repos",
	"post-merge": "update-embedded-repos",
	"post-rewrite": "update-embedded-repos",
	"reference-transaction": "reference-transaction"
};

/**
 * Install or uninstall the package's per-repo hook scripts.
 *
 * `op === "install"` copies the four hooks; `op === "uninstall"` removes only
 * the ones recognizably owned by git-embedded (any file whose content includes
 * the string "git-embedded").
 *
 * @param {"install"|"uninstall"} op
 * @param {string} gitDir
 * @param {object} [opts]
 * @param {boolean} [opts.force]
 */
export default function hooks(op, gitDir, opts = {}) {
	if (op === "install") return doInstall(gitDir, opts);
	if (op === "uninstall") return doUninstall(gitDir);
	throw new Error(`install.hooks: unknown op "${op}" (expected "install" or "uninstall")`);
}

function doInstall(gitDir, { force = false } = {}) {
	const { fs, path } = context;
	const hooksDir = path.join(gitDir, "hooks");
	fs.mkdirSync(hooksDir, { recursive: true });
	const sourceDir = self.paths.hooksSourceDir();
	const installed = [];
	const skipped = [];
	for (const [hookName, sourceName] of Object.entries(PACKAGE_HOOK_MAP)) {
		const dest = path.join(hooksDir, hookName);
		const source = path.join(sourceDir, sourceName);
		if (!force && fs.existsSync(dest)) {
			let existing;
			try {
				existing = fs.readFileSync(dest, "utf8");
			} catch {
				existing = "";
			}
			if (!existing.includes("git-embedded")) {
				skipped.push({ name: hookName, reason: "existing hook is not owned by git-embedded; pass --force to overwrite" });
				continue;
			}
		}
		self.link.copyExecutable(source, dest, { overwrite: true });
		installed.push(hookName);
		self.log.append({ op: "install-repo-hook", path: dest, source });
	}
	return { installed, skipped };
}

function doUninstall(gitDir) {
	const { fs, path } = context;
	const hooksDir = path.join(gitDir, "hooks");
	const removed = [];
	const kept = [];
	for (const hookName of Object.keys(PACKAGE_HOOK_MAP)) {
		const dest = path.join(hooksDir, hookName);
		if (!fs.existsSync(dest)) continue;
		let body;
		try {
			body = fs.readFileSync(dest, "utf8");
		} catch {
			body = "";
		}
		if (body.includes("git-embedded")) {
			fs.unlinkSync(dest);
			removed.push(hookName);
			self.log.append({ op: "uninstall-repo-hook", path: dest });
		} else {
			kept.push({ name: hookName, reason: "file is not owned by git-embedded" });
		}
	}
	return { removed, kept };
}
