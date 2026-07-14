import { context } from "@cldmv/slothlet/runtime";

function git(args, opts = {}) {
	const res = context.spawnSync("git", args, { encoding: "utf8", ...opts });
	return { code: res.status ?? 1, stdout: (res.stdout || "").trim(), stderr: (res.stderr || "").trim() };
}

/**
 * The per-clone URL registry: `embedded.<path>.url` / `embedded.<path>.branch`
 * keys in the PARENT repo's LOCAL `.git/config`. This is registry layer 1 (the
 * strictest resolution source) and it is NEVER committed — it lives only in the
 * clone that wrote it. The gitlink path is stored as the config subsection, so
 * paths with slashes (e.g. `vendor/foo`) round-trip correctly.
 *
 * @namespace api.embedded.registry
 */

/**
 * Read a child's recorded clone URL from the parent's local config.
 * @param {string} childPath gitlink path (the config subsection)
 * @param {string} [cwd] working directory inside the parent repo
 * @returns {string|null} the URL, or null when unset
 */
export function getUrl(childPath, cwd = process.cwd()) {
	const res = git(["config", "--local", "--get", `embedded.${childPath}.url`], { cwd });
	return res.code === 0 && res.stdout ? res.stdout : null;
}

/**
 * Read a child's recorded branch from the parent's local config.
 * @param {string} childPath gitlink path
 * @param {string} [cwd] working directory inside the parent repo
 * @returns {string|null} the branch, or null when unset
 */
export function getBranch(childPath, cwd = process.cwd()) {
	const res = git(["config", "--local", "--get", `embedded.${childPath}.branch`], { cwd });
	return res.code === 0 && res.stdout ? res.stdout : null;
}

/**
 * Write a child's clone URL into the parent's local config.
 * @param {string} childPath gitlink path
 * @param {string} url clone URL to record
 * @param {string} [cwd] working directory inside the parent repo
 * @returns {boolean} true on success
 */
export function setUrl(childPath, url, cwd = process.cwd()) {
	// `--` so a value starting with "-" is never parsed as a git option.
	return git(["config", "--local", "--", `embedded.${childPath}.url`, url], { cwd }).code === 0;
}

/**
 * Write a child's branch into the parent's local config.
 * @param {string} childPath gitlink path
 * @param {string} branch branch name to record
 * @param {string} [cwd] working directory inside the parent repo
 * @returns {boolean} true on success
 */
export function setBranch(childPath, branch, cwd = process.cwd()) {
	return git(["config", "--local", "--", `embedded.${childPath}.branch`, branch], { cwd }).code === 0;
}

/**
 * List every registry entry currently in the parent's local config.
 * @param {string} [cwd] working directory inside the parent repo
 * @returns {Array<{ path: string, url?: string, branch?: string }>} one entry
 *   per recorded child path
 */
export function entries(cwd = process.cwd()) {
	const res = git(["config", "--local", "--get-regexp", "^embedded\\..*\\.(url|branch)$"], { cwd });
	if (res.code !== 0) return [];
	const map = new Map();
	for (const line of res.stdout.split(/\r?\n/)) {
		if (!line) continue;
		const sp = line.indexOf(" ");
		if (sp < 0) continue;
		const fullKey = line.slice(0, sp);
		const value = line.slice(sp + 1);
		// fullKey is `embedded.<subsection>.<name>`; git preserves the subsection
		// (the path, possibly containing dots) verbatim, so split off the trailing
		// `.url`/`.branch` name and the leading `embedded.` section.
		const rest = fullKey.slice("embedded.".length);
		const lastDot = rest.lastIndexOf(".");
		if (lastDot < 0) continue;
		const sub = rest.slice(0, lastDot);
		const name = rest.slice(lastDot + 1);
		if (!map.has(sub)) map.set(sub, { path: sub });
		map.get(sub)[name] = value;
	}
	return Array.from(map.values());
}

/**
 * Record one present child: read its `remote.origin.url` and current branch and
 * write them to the parent registry. Used by `record`, `export --scan`, and the
 * `link` command after a fresh clone.
 * @param {string} childPath gitlink path
 * @param {string} root parent repo root (child lives at `<root>/<childPath>`)
 * @returns {{ path: string, url?: string, branch?: string|null, outcome: "recorded"|"no-repo"|"no-origin" }}
 */
export function recordOne(childPath, root) {
	const { fs, path } = context;
	const abs = path.resolve(root, childPath);
	const gitMarker = path.join(abs, ".git");
	if (!fs.existsSync(gitMarker)) return { path: childPath, outcome: "no-repo" };

	const urlRes = git(["-C", abs, "config", "--get", "remote.origin.url"]);
	const url = urlRes.code === 0 && urlRes.stdout ? urlRes.stdout : null;
	if (!url) return { path: childPath, outcome: "no-origin" };
	setUrl(childPath, url, root);

	const brRes = git(["-C", abs, "symbolic-ref", "--short", "HEAD"]);
	const branch = brRes.code === 0 && brRes.stdout ? brRes.stdout : null;
	if (branch) setBranch(childPath, branch, root);

	return { path: childPath, url, branch, outcome: "recorded" };
}

export default { getUrl, getBranch, setUrl, setBranch, entries, recordOne };
