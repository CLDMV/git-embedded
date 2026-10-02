/**
 *
 *	@Project: @cldmv/git-embedded
 *	@Filename: /src/api/prompt.mjs
 *	@Date: 2026-05-24T21:13:00-07:00 (1779682380)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:24-07:00 (1790968824)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { context } from "@cldmv/slothlet/runtime";

/**
 * Minimal interactive prompts. Honors `--yes` via `opts.yes` and
 * non-TTY input by returning the default.
 *
 * @namespace api.prompt
 */

export function confirm(question, opts = {}) {
	const { defaultYes = false, yes = false } = opts;
	if (yes) return Promise.resolve(true);
	if (!process.stdin.isTTY) return Promise.resolve(defaultYes);

	const suffix = defaultYes ? "[Y/n]" : "[y/N]";
	const rl = context.readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question(`${question} ${suffix} `, (answer) => {
			rl.close();
			const trimmed = (answer || "").trim().toLowerCase();
			if (trimmed === "") resolve(defaultYes);
			else if (trimmed === "y" || trimmed === "yes") resolve(true);
			else resolve(false);
		});
	});
}
