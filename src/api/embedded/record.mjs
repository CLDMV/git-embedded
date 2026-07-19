import { self, context } from "@cldmv/slothlet/runtime";

/**
 * Record engine: for each embedded child present on disk, write its
 * `remote.origin.url` and current branch into the parent's LOCAL config
 * registry. This is how a machine that already has the children populates the
 * registry so it can later `export` a manifest or re-`restore` without
 * re-deriving URLs.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd] working directory inside the parent repo
 * @param {string[]} [opts.paths] restrict to these gitlink paths (default: all
 *   gitlink children present on disk)
 * @returns {{ results: Array<{ path: string, url?: string, branch?: string|null,
 *   outcome: "recorded"|"no-repo"|"no-origin" }> }}
 */
export default function record(opts = {}) {
	const { cwd = process.cwd() } = opts;
	const { paths = [] } = opts;

	const root = self.git.getRepoRoot(cwd) || cwd;
	// Same filter-spelling normalization as restore/sync: gitlink paths from
	// gitlinks() are root-relative with forward slashes, so accept "./tests",
	// "tests/", and Windows "vendor\\foo" instead of silently not matching.
	const normalizePath = (p) =>
		String(p)
			.replace(/\\/g, "/")
			.replace(/^\.\/+/, "")
			.replace(/\/+$/, "");
	const wantSet = paths.length ? new Set(paths.map(normalizePath)) : null;

	const links = self.embedded.gitlinks(root);
	const results = [];
	for (const { path: childPath } of links) {
		if (wantSet && !wantSet.has(childPath)) continue;
		const abs = context.path.resolve(root, childPath);
		if (!context.fs.existsSync(context.path.join(abs, ".git"))) {
			// Only children present on disk can be recorded; skip the rest silently
			// unless explicitly requested.
			if (wantSet) results.push({ path: childPath, outcome: "no-repo" });
			continue;
		}
		results.push(self.embedded.registry.recordOne(childPath, root));
	}
	return { results };
}
