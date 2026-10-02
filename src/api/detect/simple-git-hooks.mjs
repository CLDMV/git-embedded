/**
 *
 *	@Project: @cldmv/git-embedded
 *	@Filename: /src/api/detect/simple-git-hooks.mjs
 *	@Date: 2026-05-24T21:13:00-07:00 (1779682380)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:17-07:00 (1790968817)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

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
