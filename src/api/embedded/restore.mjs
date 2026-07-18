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
 * Branch-aware: a branch for the child is resolved with the same layering as
 * the URL — the registry (`embedded.<path>.branch`), then the manifest — and
 * when neither supplies one it is inferred from the pin (exactly ONE `origin`
 * branch containing it). With a branch the child ends ON that branch at the
 * pin (upstream set best-effort, branch auto-registered); without one —
 * including an ambiguous pin — the checkout stays detached.
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

	// Gitlink paths from ls-tree are root-relative with forward slashes; accept
	// the common user spellings of the same path ("./tests", "tests/", Windows
	// "vendor\\foo") for --skip / path filters instead of silently not matching.
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

		const record = { path: childPath, sha, url: null, source: null, branch: null, note: null };

		if (skipSet.has(childPath)) {
			results.push({ ...record, outcome: "skipped" });
			continue;
		}

		const absChild = path.resolve(root, childPath);

		// lstat BEFORE probing for `.git` so a symlinked child is refused before
		// anything follows it. A symlink that resolves to a real repo would
		// otherwise satisfy the existsSync(.git) check below and be blessed as
		// already-present — yet the packaged hooks cd into the child and would
		// follow that link out of the parent worktree. lstat (not stat) sees the
		// link itself, and also catches a broken symlink that existsSync misses.
		let targetStat = null;
		try {
			targetStat = fs.lstatSync(absChild);
		} catch (err) {
			// Only ENOENT means "missing — clone will create it". A non-ENOENT
			// lstat error (EACCES/ENOTDIR on an existing path) must be refused, not
			// assumed absent — otherwise we could clone into, and later removeClone
			// against, a pre-existing path we can't even stat.
			if (err.code !== "ENOENT") {
				results.push({ ...record, outcome: "unresolved", note: `target unreadable (${err.code || err.message}) — refusing to touch it` });
				continue;
			}
		}
		if (targetStat && targetStat.isSymbolicLink()) {
			results.push({ ...record, outcome: "unresolved", note: "target is a symbolic link — refusing to touch it" });
			continue;
		}

		const hasGit = fs.existsSync(path.join(absChild, ".git"));
		if (hasGit) {
			results.push({ ...record, outcome: "already-present" });
			continue;
		}

		// The only acceptable pre-existing target is an EMPTY, REAL directory —
		// what a fresh parent clone materializes for a gitlink. A file or a
		// directory with contents is user data: never clone into it, never remove
		// it. (A symlink was already refused above.)
		if (targetStat) {
			let refuse = null;
			if (!targetStat.isDirectory()) refuse = "target exists and is not a directory";
			else {
				try {
					if (fs.readdirSync(absChild).length > 0) refuse = "target directory is not empty";
				} catch (err) {
					refuse = `target unreadable (${err.code || err.message})`;
				}
			}
			if (refuse) {
				results.push({ ...record, outcome: "unresolved", note: `${refuse} — refusing to touch it` });
				continue;
			}
		}

		const resolved = self.embedded.resolve(childPath, { cwd: root, manifest, base, parentOrigin });
		record.url = resolved.url;
		record.source = resolved.source;
		if (!resolved.url) {
			results.push({ ...record, outcome: "unresolved", note: "no URL from local config, manifest, --base, or convention" });
			continue;
		}

		// Branch precedence mirrors URL precedence: the per-clone registry first,
		// then the manifest. Inference from the pin needs the clone to exist, so
		// it runs after SHA verification below. Own-property manifest access for
		// the same reason as resolve (a child path named "constructor").
		const manifestChild =
			manifest && manifest.children && Object.hasOwn(manifest.children, childPath) ? manifest.children[childPath] : null;
		const wantedBranch = self.embedded.registry.getBranch(childPath, root) || (manifestChild && manifestChild.branch) || null;
		record.branch = wantedBranch;

		if (dryRun) {
			results.push({ ...record, outcome: "restored", dryRun: true });
			continue;
		}

		const existedBefore = fs.existsSync(absChild);
		// `--` ends option parsing: a URL from config/manifest/--base that starts
		// with "-" must never be interpreted as a git option (e.g. --upload-pack).
		// cwd=root anchors a RELATIVE url (e.g. "../sibling.git") to the parent repo
		// root, so a restore resolves the same regardless of where the caller ran
		// from. Without it git resolves the url against the Node process CWD (the
		// destination is absolute, so only the source url is affected).
		const clone = git(["clone", "--quiet", "--", resolved.url, absChild], { cwd: root });
		if (clone.code !== 0) {
			if (fs.existsSync(absChild)) removeClone(absChild, existedBefore);
			results.push({ ...record, outcome: "unresolved", note: `clone failed: ${clone.stderr || `exit ${clone.code}`}` });
			continue;
		}

		// SHA verification: the parent's pinned commit MUST exist in the clone.
		// One fetch is attempted before giving up, in case origin's default
		// refspec did not include the pinned commit.
		let present = git(["-C", absChild, "cat-file", "-e", `${sha}^{commit}`]).code === 0;
		let fetchErr = null;
		if (!present) {
			const fetch = git(["-C", absChild, "fetch", "--quiet", "origin"]);
			if (fetch.code !== 0) fetchErr = fetch.stderr || `git fetch exited ${fetch.code}`;
			present = git(["-C", absChild, "cat-file", "-e", `${sha}^{commit}`]).code === 0;
		}
		if (!present) {
			removeClone(absChild, existedBefore);
			// A failed fetch (auth/network) is not the same as "wrong repo" — surface
			// it so a pinned-mismatch isn't misread as a bad convention guess.
			const why = fetchErr
				? `fetch from ${resolved.source} repo failed (${fetchErr})`
				: `pinned ${sha.slice(0, 12)} absent in ${resolved.source} repo`;
			results.push({
				...record,
				outcome: "pinned-mismatch",
				note: `${why}; clone removed`
			});
			continue;
		}

		// Branch-aware checkout: registry/manifest branch wins; otherwise infer it
		// from the pin. Attach failure (e.g. an invalid branch name in the
		// registry) falls back to today's detached checkout rather than failing
		// the restore — the pin is verified present, so detached is always safe.
		const branch = wantedBranch || self.embedded.branch.infer(absChild, sha);
		let attached = false;
		if (branch) {
			attached = self.embedded.branch.attach(absChild, branch, sha);
			if (!attached) record.note = `could not attach branch ${branch}; checked out detached`;
		}
		record.branch = attached ? branch : null;
		if (!attached) {
			const checkout = git(["-C", absChild, "checkout", "--quiet", "--detach", sha]);
			if (checkout.code !== 0) {
				removeClone(absChild, existedBefore);
				results.push({
					...record,
					outcome: "pinned-mismatch",
					note: `could not check out ${sha.slice(0, 12)}: ${checkout.stderr || `git checkout exited ${checkout.code}`}; clone removed`
				});
				continue;
			}
		}

		// Persist the resolved URL (and the branch the child ended on) so day-2
		// re-restores and `sync` don't re-derive them.
		self.embedded.registry.setUrl(childPath, resolved.url, root);
		if (attached) self.embedded.registry.setBranch(childPath, branch, root);
		results.push({ ...record, outcome: "restored" });
	}

	const exitCode = results.some((r) => r.outcome === "unresolved" || r.outcome === "pinned-mismatch") ? 1 : 0;
	return { results, exitCode };
}
