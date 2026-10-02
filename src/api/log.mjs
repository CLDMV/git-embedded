/**
 *
 *	@Project: @cldmv/git-embedded
 *	@Filename: /src/api/log.mjs
 *	@Date: 2026-05-24T21:13:00-07:00 (1779682380)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:23-07:00 (1790968823)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { self, context } from "@cldmv/slothlet/runtime";

/**
 * Append-only JSONL transaction log. Each install/uninstall operation appends
 * one line; uninstall replays the log to know what to remove.
 *
 * @namespace api.log
 */

export function append(entry) {
	const { fs, path } = context;
	const log = self.paths.transactionLogPath();
	fs.mkdirSync(path.dirname(log), { recursive: true });
	const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
	fs.appendFileSync(log, line);
}

export function read() {
	const { fs } = context;
	const log = self.paths.transactionLogPath();
	if (!fs.existsSync(log)) return [];
	return fs
		.readFileSync(log, "utf8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
}

export function path() {
	return self.paths.transactionLogPath();
}
