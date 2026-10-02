/**
 *
 *	@Project: @cldmv/git-embedded
 *	@Filename: /src/api/detect/husky.mjs
 *	@Date: 2026-05-24T21:13:00-07:00 (1779682380)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:16-07:00 (1790968816)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

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
