import { self, context } from "@cldmv/slothlet/runtime";

function git(args, opts = {}) {
	const res = context.spawnSync("git", args, { encoding: "utf8", ...opts });
	return { code: res.status ?? 1, stdout: (res.stdout || "").trim(), stderr: (res.stderr || "").trim() };
}

/**
 * Remove a clone WE created, without ever touching a pre-existing directory.
 * When the target did not exist before we cloned, the whole directory is ours
 * to delete. When it pre-existed (git materializes a gitlink as an empty dir),
 * only our clone's contents are removed — the directory itself is left in place.
 * @param {string} absChild absolute child path
 * @param {boolean} existedBefore whether the directory existed before the clone
 */
function removeClone(absChild, existedBefore) {
	const { fs, path } = context;
	if (!existedBefore) {
		fs.rmSync(absChild, { recursive: true, force: true });
		return;
	}
	for (const entry of fs.readdirSync(absChild)) {
		fs.rmSync(path.join(absChild, entry), { recursive: true, force: true });
	}
}

/**
 * Restore engine: clone missing embedded children and check out their pinned
 * SHAs, resolving each URL strictest-source-first and SHA-verifying every clone
 * so a wrong convention guess fails closed.
 *
 * Partial restore is normal — a public cloner without access to a private child
 * passes that path in `skip` and the rest still restore.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd] working directory inside the parent repo
 * @param {string[]} [opts.paths] restrict to these gitlink paths (default: all)
 * @param {string} [opts.from] manifest file to read child URLs from
 * @param {string} [opts.base] explicit URL base (`<base>/<basename>.git`)
 * @param {string[]} [opts.skip] gitlink paths to skip
 * @param {boolean} [opts.dryRun] resolve and report only; clone/write nothing
 * @returns {{ results: Array<object>, exitCode: number }} per-child outcomes and
 *   a process exit code (non-zero when any non-skipped child ends `unresolved`
 *   or `pinned-mismatch`)
 */
export default function restore(opts = {}) {
	const { fs, path } = context;
	const { cwd = process.cwd(), paths = [], from = null, base = null, skip = [], dryRun = false } = opts;

	const root = self.git.getRepoRoot(cwd) || cwd;
	const parentOrigin = git(["-C", root, "config", "--get", "remote.origin.url"]).stdout || null;
	const manifest = from ? self.embedded.manifest.read(from, cwd) : null;

	const skipSet = new Set(skip);
	const wantSet = paths.length ? new Set(paths) : null;

	const links = self.embedded.gitlinks(root);
	const results = [];

	for (const { path: childPath, sha } of links) {
		if (wantSet && !wantSet.has(childPath)) continue;

		const record = { path: childPath, sha, url: null, source: null, note: null };

		if (skipSet.has(childPath)) {
			results.push({ ...record, outcome: "skipped" });
			continue;
		}

		const absChild = path.resolve(root, childPath);
		const hasGit = fs.existsSync(path.join(absChild, ".git"));
		if (hasGit) {
			results.push({ ...record, outcome: "already-present" });
			continue;
		}

		const resolved = self.embedded.resolve(childPath, { cwd: root, manifest, base, parentOrigin });
		record.url = resolved.url;
		record.source = resolved.source;
		if (!resolved.url) {
			results.push({ ...record, outcome: "unresolved", note: "no URL from local config, manifest, --base, or convention" });
			continue;
		}

		if (dryRun) {
			results.push({ ...record, outcome: "restored", dryRun: true });
			continue;
		}

		const existedBefore = fs.existsSync(absChild);
		const clone = git(["clone", "--quiet", resolved.url, absChild]);
		if (clone.code !== 0) {
			if (fs.existsSync(absChild)) removeClone(absChild, existedBefore);
			results.push({ ...record, outcome: "unresolved", note: `clone failed: ${clone.stderr || `exit ${clone.code}`}` });
			continue;
		}

		// SHA verification: the parent's pinned commit MUST exist in the clone.
		// One fetch is attempted before giving up, in case origin's default
		// refspec did not include the pinned commit.
		let present = git(["-C", absChild, "cat-file", "-e", `${sha}^{commit}`]).code === 0;
		if (!present) {
			git(["-C", absChild, "fetch", "--quiet", "origin"]);
			present = git(["-C", absChild, "cat-file", "-e", `${sha}^{commit}`]).code === 0;
		}
		if (!present) {
			removeClone(absChild, existedBefore);
			results.push({
				...record,
				outcome: "pinned-mismatch",
				note: `pinned ${sha.slice(0, 12)} absent in ${resolved.source} repo; clone removed`
			});
			continue;
		}

		const checkout = git(["-C", absChild, "checkout", "--quiet", "--detach", sha]);
		if (checkout.code !== 0) {
			removeClone(absChild, existedBefore);
			results.push({ ...record, outcome: "pinned-mismatch", note: `could not check out ${sha.slice(0, 12)}; clone removed` });
			continue;
		}

		// Persist the resolved URL so day-2 re-restores don't re-derive it.
		self.embedded.registry.setUrl(childPath, resolved.url, root);
		results.push({ ...record, outcome: "restored" });
	}

	const exitCode = results.some((r) => r.outcome === "unresolved" || r.outcome === "pinned-mismatch") ? 1 : 0;
	return { results, exitCode };
}
