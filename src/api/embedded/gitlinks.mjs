import { context } from "@cldmv/slothlet/runtime";

function git(args, opts = {}) {
	const res = context.spawnSync("git", args, { encoding: "utf8", ...opts });
	return { code: res.status ?? 1, stdout: (res.stdout || "").trim(), stderr: (res.stderr || "").trim() };
}

/**
 * Enumerate the anonymous gitlinks recorded in the parent's HEAD tree.
 *
 * Reads `git ls-tree -r HEAD` and keeps only mode-`160000` / type-`commit`
 * entries — the same detection the `update-embedded-repos` and
 * `reference-transaction` hooks use. No `.gitmodules` is consulted; the pinned
 * SHA in the parent tree is the only committed information about a child.
 *
 * @param {string} [cwd] working directory inside the parent repo (default: cwd)
 * @returns {Array<{ path: string, sha: string }>} gitlink path + pinned SHA,
 *   in tree order. Empty when HEAD has no gitlinks or `cwd` is not a repo.
 *
 * @example
 * const links = self.embedded.gitlinks();
 * // → [{ path: "tests", sha: "a1b2c3…" }, { path: "vendor/foo", sha: "d4e5…" }]
 */
export default function gitlinks(cwd = process.cwd()) {
	const res = git(["ls-tree", "-r", "HEAD"], { cwd });
	if (res.code !== 0) return [];
	const out = [];
	for (const line of res.stdout.split(/\r?\n/)) {
		if (!line) continue;
		// <mode> SP <type> SP <sha> TAB <path>
		const tab = line.indexOf("\t");
		if (tab < 0) continue;
		const meta = line.slice(0, tab).split(/\s+/);
		if (meta.length < 3) continue;
		const [mode, type, sha] = meta;
		if (mode !== "160000" || type !== "commit") continue;
		out.push({ path: line.slice(tab + 1), sha });
	}
	return out;
}
