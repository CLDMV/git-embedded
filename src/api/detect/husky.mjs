import { context } from "@cldmv/slothlet/runtime";

/**
 * Detect Husky in a repo.
 *
 * @param {string} repoRoot absolute path to the repo root
 * @returns {{kind:"husky",dir:string,prepare:string|null,version:string|null}|null}
 */
export default function husky(repoRoot) {
	if (!repoRoot) return null;
	const { fs, path, wispSync } = context;
	const dir = path.join(repoRoot, ".husky");
	if (!fs.existsSync(dir)) return null;
	let pkg = null;
	try {
		pkg = wispSync(path.join(repoRoot, "package.json"));
	} catch {
		pkg = null;
	}
	const prepare = pkg && pkg.scripts && pkg.scripts.prepare;
	const version = pkg && ((pkg.devDependencies && pkg.devDependencies.husky) || (pkg.dependencies && pkg.dependencies.husky));
	return { kind: "husky", dir, prepare: prepare || null, version: version || null };
}
