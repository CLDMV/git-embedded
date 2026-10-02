/**
 *
 *	@Project: @cldmv/git-embedded
 *	@Filename: /src/api/cli/doctor.mjs
 *	@Date: 2026-05-24T21:13:00-07:00 (1779682380)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:13-07:00 (1790968813)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { self } from "@cldmv/slothlet/runtime";

export const spec = {
	command: "doctor",
	description: "Inspect the current environment and report what would happen on install. Takes no action.",
	examples: ["$ git-embedded doctor"]
};

export async function run() {
	const result = await self.detect.run(process.cwd());
	self.report.detectionHeader(result);
	self.report.message(result.kind);
}

export default { spec, run };
