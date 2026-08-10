import { context } from "@cldmv/slothlet/runtime";

export const REQUIRED_HOOKS = ["post-checkout", "post-merge", "post-rewrite", "reference-transaction"];

export const STANDARD_HOOK_NAMES = [
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

const DISPATCHER_MARKER = "# git-embedded-compatible dispatcher";

const CHAIN_PATTERNS = [/exec\s+"?\$repo_hook"?/, /exec\s+"?\$\{?repo_hook\}?"?/, /exec\s+"?\$git_dir\/hooks\/\$hook"?/];

function readFull(p) {
	try {
		return context.fs.readFileSync(p, "utf8");
	} catch {
		return null;
	}
}

function chainCheck(text) {
	if (!text) return false;
	return CHAIN_PATTERNS.some((re) => re.test(text));
}

/**
 * Inspect a hooks directory and classify it. The return shape is one of:
 *   { kind: "dispatcher-canonical-complete", dispatcherPath, missing: [], present: [...] }
 *   { kind: "dispatcher-missing-symlinks", dispatcherPath, missing: [...], present: [...] }
 *   { kind: "dispatcher-non-conforming", dispatcherPath, reason }
 *   { kind: "bare-githooks", hookFiles: [...] }
 *   { kind: "empty" }
 *
 * @param {string} dir
 */
export default function dispatcher(dir) {
	const { fs, path } = context;
	if (!dir) return { kind: "empty" };

	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return { kind: "empty", reason: "directory not readable" };
	}

	const fileEntries = entries.filter((e) => !e.name.startsWith("."));
	if (fileEntries.length === 0) return { kind: "empty" };

	let dispatcherPath = null;
	const dispatchCandidate = path.join(dir, "_dispatch");
	if (fs.existsSync(dispatchCandidate)) dispatcherPath = dispatchCandidate;

	const byInode = new Map();
	const symlinkTargets = new Map();
	const realFiles = new Map();

	for (const entry of fileEntries) {
		const full = path.join(dir, entry.name);
		let lst;
		try {
			lst = fs.lstatSync(full);
		} catch {
			continue;
		}
		if (lst.isSymbolicLink()) {
			try {
				const target = fs.readlinkSync(full);
				const resolved = path.isAbsolute(target) ? target : path.resolve(dir, target);
				symlinkTargets.set(entry.name, resolved);
			} catch {
				symlinkTargets.set(entry.name, null);
			}
		} else if (lst.isFile()) {
			realFiles.set(entry.name, full);
			const key = `${lst.dev}:${lst.ino}`;
			if (!byInode.has(key)) byInode.set(key, []);
			byInode.get(key).push(entry.name);
		}
	}

	if (!dispatcherPath) {
		let best = [];
		for (const names of byInode.values()) {
			const standard = names.filter((n) => STANDARD_HOOK_NAMES.includes(n));
			if (standard.length >= 3 && standard.length > best.length) best = standard;
		}
		if (best.length > 0) dispatcherPath = path.join(dir, best[0]);
	}

	let copyClusterTarget = null;
	if (!dispatcherPath && realFiles.size >= 3) {
		const contentBuckets = new Map();
		for (const [name, p] of realFiles) {
			if (!STANDARD_HOOK_NAMES.includes(name)) continue;
			try {
				const key = fs.readFileSync(p).toString("base64");
				if (!contentBuckets.has(key)) contentBuckets.set(key, []);
				contentBuckets.get(key).push(name);
			} catch {
				continue;
			}
		}
		let best = [];
		for (const names of contentBuckets.values()) {
			if (names.length >= 3 && names.length > best.length) best = names;
		}
		if (best.length > 0) {
			copyClusterTarget = best;
			dispatcherPath = path.join(dir, best[0]);
		}
	}

	if (!dispatcherPath) {
		const hookFiles = fileEntries.map((e) => e.name).filter((n) => STANDARD_HOOK_NAMES.includes(n) || !n.includes("."));
		if (hookFiles.length === 0) return { kind: "empty" };
		return { kind: "bare-githooks", dir, hookFiles };
	}

	const dispatcherText = readFull(dispatcherPath);
	const hasChain = chainCheck(dispatcherText);
	const hasMarker = dispatcherText && dispatcherText.includes(DISPATCHER_MARKER);

	if (!hasChain) {
		return {
			kind: "dispatcher-non-conforming",
			dir,
			dispatcherPath,
			reason: "dispatcher does not chain to per-repo hooks"
		};
	}

	const dispatcherStat = (() => {
		try {
			return fs.statSync(dispatcherPath);
		} catch {
			return null;
		}
	})();
	const dispatcherInodeKey = dispatcherStat ? `${dispatcherStat.dev}:${dispatcherStat.ino}` : null;
	const dispatcherReal = (() => {
		try {
			return fs.realpathSync(dispatcherPath);
		} catch {
			return dispatcherPath;
		}
	})();

	const present = [];
	const missing = [];
	for (const hook of REQUIRED_HOOKS) {
		const full = path.join(dir, hook);
		if (!fs.existsSync(full) && !symlinkTargets.has(hook)) {
			missing.push(hook);
			continue;
		}

		let resolved = null;
		if (symlinkTargets.has(hook)) {
			resolved = symlinkTargets.get(hook);
		} else {
			try {
				resolved = fs.realpathSync(full);
			} catch {
				resolved = full;
			}
		}

		if (resolved && path.resolve(resolved) === path.resolve(dispatcherReal)) {
			present.push(hook);
			continue;
		}

		try {
			const lst = fs.lstatSync(full);
			if (!lst.isSymbolicLink()) {
				const st = fs.statSync(full);
				const key = `${st.dev}:${st.ino}`;
				if (key === dispatcherInodeKey) {
					present.push(hook);
					continue;
				}
			}
		} catch {
			// fall through
		}

		if (copyClusterTarget && copyClusterTarget.includes(hook)) {
			present.push(hook);
			continue;
		}

		missing.push(hook);
	}

	if (missing.length === 0) {
		return { kind: "dispatcher-canonical-complete", dir, dispatcherPath, hasMarker, present };
	}
	return { kind: "dispatcher-missing-symlinks", dir, dispatcherPath, hasMarker, present, missing };
}
