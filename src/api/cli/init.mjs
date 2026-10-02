/**
 *
 *	@Project: @cldmv/git-embedded
 *	@Filename: /src/api/cli/init.mjs
 *	@Date: 2026-05-24T21:13:00-07:00 (1779682380)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:14-07:00 (1790968814)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { self, context } from "@cldmv/slothlet/runtime";

export const spec = {
	command: "init",
	description: "Set up the current repo for embedded gitlinks: run install-hooks, then silence the 'embedded git repository' advice.",
	options: [
		["--no-symlinks", "Forwarded to install-hooks: use hard links instead of symbolic links."],
		["--yes", "Forwarded to install-hooks: skip confirmation prompts."],
		["--dispatcher-dir <path>", "Forwarded to install-hooks: override the default dispatcher directory."]
	],
	examples: ["$ git-embedded init", "$ git-embedded init --yes"]
};

export async function run(opts = {}) {
	await self.cli.installHooks.run(opts);

	const { spawnSync } = context;
	const cfg = spawnSync("git", ["config", "advice.addEmbeddedRepo", "false"], { encoding: "utf8" });
	if (cfg.status === 0) {
		self.report.success("Silenced 'embedded git repository' advice (git config advice.addEmbeddedRepo=false).");
	} else {
		/* v8 ignore next -- git normally writes config failures to stderr; the `|| stdout` fallback covers an empty-stderr failure (e.g. signal kill) — real, just not reproducible in the suite */
		self.report.warn(`Could not set git config advice.addEmbeddedRepo: ${cfg.stderr || cfg.stdout}`);
	}
}

export default { spec, run };
