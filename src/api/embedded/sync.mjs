import { self, context } from "@cldmv/slothlet/runtime";

function git(args, opts = {}) {
	const res = context.spawnSync("git", args, { encoding: "utf8", ...opts });
	return { code: res.status ?? 1, stdout: (res.stdout || "").trim(), stderr: (res.stderr || "").trim() };
}

/**
 * Sync engine: move already-present embedded children to the pins in the
 * parent's HEAD (day-2 — after the parent pulled new gitlink pins). The parent
 * itself is never touched; pulling it first is the caller's step.
 *
 * Per child, in order:
 *   - symlinked gitlink path → `sync-failed`, refusing to touch it (never run
 *     git through a link out of the worktree — same guard as restore/link).
 *   - HEAD already at the pin → `in-sync` (done).
 *   - uncommitted changes → `dirty`, left alone (that's your work).
 *   - pin absent locally → one `git fetch origin`; still absent →
 *     `pin-unavailable` (a real failure — non-zero exit).
 *   - on the REGISTERED branch (`embedded.<path>.branch`) and clean →
 *     fast-forward-only: HEAD must be an ancestor of the pin, then the branch
 *     is moved to the pin (upstream refreshed best-effort). Ahead/diverged →
 *     `ahead`, left alone (your work).
 *   - on any other branch → `unregistered-branch`, left alone (reported).
 *   - detached and clean → detach to the pin.
 *
 * Only `pin-unavailable` and `sync-failed` (an unexpected git failure — reading
 * HEAD or status, the branch move, or the checkout) make the exit code
 * non-zero; the left-alone outcomes are deliberate protection of in-progress
 * work, not errors.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd] working directory inside the parent repo
 * @param {string[]} [opts.paths] restrict to these gitlink paths (default: all)
 * @param {string[]} [opts.skip] gitlink paths to skip
 * @param {boolean} [opts.dryRun] classify and report only; fetch/move nothing
 * @returns {{ results: Array<object>, exitCode: number }} per-child outcomes
 *   (`synced`, `in-sync`, `dirty`, `ahead`, `unregistered-branch`,
 *   `pin-unavailable`, `sync-failed`, `skipped`, `no-repo`) and a process exit
 *   code (non-zero when any child ends `pin-unavailable` or `sync-failed`)
 */
export default function sync(opts = {}) {
	const { fs, path } = context;
	const { cwd = process.cwd(), paths = [], skip = [], dryRun = false } = opts;

	const root = self.git.getRepoRoot(cwd) || cwd;

	// Same filter-spelling normalization as restore: gitlink paths are
	// root-relative with forward slashes; accept "./tests", "tests/", "vendor\\foo".
	const normalizePath = (p) =>
		String(p)
			.replace(/\\/g, "/")
			.replace(/^\.\/+/, "")
			.replace(/\/+$/, "");
	const skipSet = new Set(skip.map(normalizePath));
	const wantSet = paths.length ? new Set(paths.map(normalizePath)) : null;

	const links = self.embedded.gitlinks(root);
	const results = [];

	for (const { path: childPath, sha } of links) {
		if (wantSet && !wantSet.has(childPath)) continue;

		const record = { path: childPath, sha, branch: null, note: null };

		if (skipSet.has(childPath)) {
			results.push({ ...record, outcome: "skipped" });
			continue;
		}

		const absChild = path.resolve(root, childPath);

		// Refuse a symlinked gitlink path before touching it: every git command
		// below runs with `-C absChild`, so a symlink pointing outside the parent
		// worktree would have us fetch/checkout out there — the same risk restore
		// and link already refuse. lstat sees the link itself (existsSync follows
		// it); a symlink here is always an anomaly, so surface it (non-zero exit)
		// even on an unfiltered run.
		let linkStat = null;
		try {
			linkStat = fs.lstatSync(absChild);
		} catch (err) {
			// Only ENOENT means "missing". A non-ENOENT lstat error (EACCES/ENOTDIR
			// on an existing path) is a real failure, not an absent child — surface
			// it rather than silently proceeding.
			if (err.code !== "ENOENT") {
				results.push({ ...record, outcome: "sync-failed", note: `gitlink path unreadable (${err.code || err.message})` });
				continue;
			}
			/* ENOENT — missing; handled as no-repo below */
		}
		if (linkStat && linkStat.isSymbolicLink()) {
			results.push({ ...record, outcome: "sync-failed", note: "gitlink path is a symbolic link — refusing to touch it" });
			continue;
		}

		if (!fs.existsSync(path.join(absChild, ".git"))) {
			// A missing child is restore's job, not sync's; report it only when the
			// caller asked for this path explicitly (mirrors record's idiom).
			if (wantSet) results.push({ ...record, outcome: "no-repo", note: "not present on disk — run restore" });
			continue;
		}

		const headRes = git(["-C", absChild, "rev-parse", "HEAD"]);
		if (headRes.code !== 0) {
			results.push({
				...record,
				outcome: "sync-failed",
				note: `could not read HEAD: ${headRes.stderr || `git rev-parse exited ${headRes.code}`}`
			});
			continue;
		}
		const head = headRes.stdout;
		if (head === sha) {
			results.push({ ...record, outcome: "in-sync" });
			continue;
		}

		// A non-zero `git status` is a command failure (corrupt repo, permissions),
		// not "uncommitted changes" — report it as sync-failed so the exit code is
		// non-zero and stderr surfaces, instead of mislabeling it dirty.
		const status = git(["-C", absChild, "status", "--porcelain"]);
		if (status.code !== 0) {
			results.push({ ...record, outcome: "sync-failed", note: `git status failed: ${status.stderr || `exit ${status.code}`}` });
			continue;
		}
		if (status.stdout) {
			results.push({ ...record, outcome: "dirty", note: "pin moved but child has uncommitted changes — left alone" });
			continue;
		}

		// Pin availability: one fetch before giving up. A dry run must not write
		// even to the object store, so it reports optimistically (like restore's
		// dry run) with a note instead of fetching.
		let pinPresent = git(["-C", absChild, "cat-file", "-e", `${sha}^{commit}`]).code === 0;
		if (!pinPresent && !dryRun) {
			const fetch = git(["-C", absChild, "fetch", "--quiet", "origin"]);
			if (fetch.code !== 0) {
				// A failed fetch (auth/network) is a real error, not "pin genuinely
				// absent" — report sync-failed with stderr so it's actionable.
				results.push({ ...record, outcome: "sync-failed", note: `git fetch origin failed: ${fetch.stderr || `exit ${fetch.code}`}` });
				continue;
			}
			pinPresent = git(["-C", absChild, "cat-file", "-e", `${sha}^{commit}`]).code === 0;
			if (!pinPresent) {
				results.push({ ...record, outcome: "pin-unavailable", note: `pinned ${sha.slice(0, 12)} not found at origin after fetch` });
				continue;
			}
		}
		if (!pinPresent && dryRun) record.note = "pin not in the local object store — a real run would fetch origin first";

		const branchRes = git(["-C", absChild, "branch", "--show-current"]);
		if (branchRes.code !== 0) {
			results.push({
				...record,
				outcome: "sync-failed",
				note: `could not read current branch: ${branchRes.stderr || `git branch --show-current exited ${branchRes.code}`}`
			});
			continue;
		}
		const branch = branchRes.stdout || null;
		const registered = self.embedded.registry.getBranch(childPath, root);

		if (branch && (!registered || branch !== registered)) {
			results.push({
				...record,
				branch,
				outcome: "unregistered-branch",
				note: `pin moved but child is on unregistered branch '${branch}' — left alone`
			});
			continue;
		}

		if (branch) {
			// The child LIVES on this branch (registry says so) — move the branch to
			// the pin, fast-forward only: HEAD must be an ancestor of the pin.
			// Commits beyond the pin are your work and stay untouched. With the pin
			// object absent (dry run), ancestry is unknowable — keep the optimistic
			// dry-run report.
			const ancestor = pinPresent ? git(["-C", absChild, "merge-base", "--is-ancestor", "HEAD", sha]).code === 0 : true;
			if (!ancestor) {
				results.push({
					...record,
					branch,
					outcome: "ahead",
					note: `on '${branch}' with commits beyond the pin — left alone (your work)`
				});
				continue;
			}
			if (dryRun) {
				results.push({ ...record, branch, outcome: "synced", dryRun: true });
				continue;
			}
			if (!self.embedded.branch.attach(absChild, branch, sha)) {
				results.push({ ...record, branch, outcome: "sync-failed", note: `could not move branch ${branch} to ${sha.slice(0, 12)}` });
				continue;
			}
			results.push({ ...record, branch, outcome: "synced" });
			continue;
		}

		// Detached and clean: snap to the pin, staying detached.
		if (dryRun) {
			results.push({ ...record, outcome: "synced", dryRun: true });
			continue;
		}
		const checkout = git(["-C", absChild, "checkout", "--quiet", "--detach", sha]);
		if (checkout.code !== 0) {
			results.push({ ...record, outcome: "sync-failed", note: `could not check out ${sha.slice(0, 12)}` });
			continue;
		}
		results.push({ ...record, outcome: "synced" });
	}

	const exitCode = results.some((r) => r.outcome === "pin-unavailable" || r.outcome === "sync-failed") ? 1 : 0;
	return { results, exitCode };
}
