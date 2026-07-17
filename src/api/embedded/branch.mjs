import { context } from "@cldmv/slothlet/runtime";

function git(args, opts = {}) {
	const res = context.spawnSync("git", args, { encoding: "utf8", ...opts });
	return { code: res.status ?? 1, stdout: (res.stdout || "").trim(), stderr: (res.stderr || "").trim() };
}

/**
 * Branch helpers for embedded children — inference of the branch a pin lives
 * on, and attaching a child to a branch at a pin. Used by `restore` (initial
 * branch-aware checkout) and `sync` (day-2 fast-forward of the registered
 * branch).
 *
 * @namespace api.embedded.branch
 */

/**
 * Infer the branch a pinned commit lives on: exactly ONE `origin` remote
 * branch must contain the pin, otherwise inference declines (returns null) and
 * the caller keeps detached-HEAD behavior.
 *
 * Full refnames (`%(refname)`) are load-bearing: `origin/HEAD` short-forms to
 * bare `origin`, which would enter the candidate set as a phantom "branch" and
 * poison the uniqueness check. Matching `refs/remotes/origin/<name>` and
 * excluding `HEAD` explicitly keeps the symref out.
 *
 * @param {string} childDir absolute path of the child working tree
 * @param {string} sha the pinned commit
 * @returns {string|null} the single containing branch name, or null when the
 *   pin is on no remote branch or more than one (ambiguous)
 */
export function infer(childDir, sha) {
	const res = git(["-C", childDir, "branch", "-r", "--contains", sha, "--format=%(refname)"]);
	if (res.code !== 0) return null;
	const names = res.stdout
		.split(/\r?\n/)
		.map((line) => (line.match(/^refs\/remotes\/origin\/(?!HEAD$)(.+)$/) || [])[1])
		.filter(Boolean);
	const unique = new Set(names);
	return unique.size === 1 ? names[0] : null;
}

/**
 * Put a child ON `branch` at `sha`: `checkout -B` (create or reset the local
 * branch at the pin) plus a soft `--set-upstream-to=origin/<branch>` — soft
 * because a registered branch need not exist on the remote (a local working
 * branch is legitimate), and tracking is a convenience, not a correctness
 * requirement.
 *
 * @param {string} childDir absolute path of the child working tree
 * @param {string} branch branch name to attach
 * @param {string} sha the pinned commit the branch should point at
 * @returns {boolean} true when the checkout succeeded (upstream is best-effort)
 */
export function attach(childDir, branch, sha) {
	const checkout = git(["-C", childDir, "checkout", "--quiet", "-B", branch, sha]);
	if (checkout.code !== 0) return false;
	git(["-C", childDir, "branch", `--set-upstream-to=origin/${branch}`, branch]);
	return true;
}

export default { infer, attach };
