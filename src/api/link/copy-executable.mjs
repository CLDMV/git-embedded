/**
 *
 *	@Project: @cldmv/git-embedded
 *	@Filename: /src/api/link/copy-executable.mjs
 *	@Date: 2026-05-24T21:13:00-07:00 (1779682380)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:22-07:00 (1790968822)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { context } from "@cldmv/slothlet/runtime";

/**
 * Copy a file to a destination, preserving the +x bit on Unix.
 *
 * @param {string} source
 * @param {string} dest
 * @param {object} [opts]
 * @param {boolean} [opts.overwrite=true]
 */
export default function copyExecutable(source, dest, { overwrite = true } = {}) {
	const { fs, path } = context;
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	if (overwrite) {
		try {
			fs.lstatSync(dest);
			fs.unlinkSync(dest);
		} catch {
			// nothing to remove
		}
	}
	fs.copyFileSync(source, dest);
	if (process.platform !== "win32") {
		const st = fs.statSync(dest);
		fs.chmodSync(dest, st.mode | 0o111);
	}
}
