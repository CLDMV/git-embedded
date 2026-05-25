import { context } from "@cldmv/slothlet/runtime";

/**
 * Detect simple-git-hooks in a repo.
 *
 * @param {string} repoRoot
 * @returns {{kind:"simple-git-hooks",configIn:string,config?:object}|null}
 */
export default function simpleGitHooks(repoRoot) {
	if (!repoRoot) return null;
	const { fs, path, wispSync } = context;
	let pkg = null;
	try {
		pkg = wispSync(path.join(repoRoot, "package.json"));
	} catch {
		pkg = null;
	}
	if (pkg && pkg["simple-git-hooks"]) {
		return { kind: "simple-git-hooks", configIn: "package.json", config: pkg["simple-git-hooks"] };
	}
	const standalone = path.join(repoRoot, ".simple-git-hooks.json");
	if (fs.existsSync(standalone)) {
		return { kind: "simple-git-hooks", configIn: standalone };
	}
	return null;
}
