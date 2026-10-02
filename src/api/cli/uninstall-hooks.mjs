/**
 *
 *	@Project: @cldmv/git-embedded
 *	@Filename: /src/api/cli/uninstall-hooks.mjs
 *	@Date: 2026-05-24T21:13:00-07:00 (1779682380)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:15-07:00 (1790968815)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { self } from "@cldmv/slothlet/runtime";

export const spec = {
	command: "uninstall-hooks",
	description: "Remove git-embedded's hook scripts from this repo's .git/hooks directory. Leaves other hooks untouched.",
	examples: ["$ git-embedded uninstall-hooks"]
};

export async function run() {
	const gitDir = self.git.getGitDir(process.cwd());
	if (!gitDir) {
		self.report.error("Not inside a git repository.");
		process.exit(2);
	}
	const out = await self.install.hooks("uninstall", gitDir);
	if (out.removed.length === 0) self.report.plain("No git-embedded hooks found in this repo.");
	else self.report.success(`Removed per-repo hooks: ${out.removed.join(", ")}`);
	for (const k of out.kept) self.report.warn(`Left ${k.name} in place: ${k.reason}`);
}

export default { spec, run };
