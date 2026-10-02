/**
 *
 *	@Project: @cldmv/git-embedded
 *	@Filename: /src/api/cli/version.mjs
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

import { self, context } from "@cldmv/slothlet/runtime";

export const spec = {
	command: "version",
	aliases: ["-V", "--version"],
	description: "Print git-embedded, node, and platform versions.",
	examples: ["$ git-embedded version"]
};

export function run() {
	const pkg = context.wispSync(context.path.join(self.paths.packageRoot(), "package.json"));
	console.log(`${pkg.name} ${pkg.version}`);
	console.log(`node ${process.version.replace(/^v/, "")}`);
	console.log(`platform ${process.platform}`);
}

export default { spec, run };
