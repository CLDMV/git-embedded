/**
 *
 *	@Project: @cldmv/git-embedded
 *	@Filename: /src/api/messages/load.mjs
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

const KIND_TO_FILE = {
	none: "setup-none.md",
	"dispatcher-canonical-complete": "setup-dispatcher-canonical-complete.md",
	"dispatcher-missing-symlinks": "setup-dispatcher-missing-symlinks.md",
	"dispatcher-non-conforming": "setup-dispatcher-non-conforming.md",
	husky: "setup-husky.md",
	lefthook: "setup-lefthook.md",
	"simple-git-hooks": "setup-simple-git-hooks.md",
	"pre-commit": "setup-pre-commit.md",
	"bare-githooks": "setup-bare-githooks.md",
	"system-hookspath": "setup-system-hookspath.md",
	"init-templatedir": "setup-init-templatedir.md"
};

/**
 * Read the markdown body for a detection classification kind, verbatim.
 *
 * @param {string} kind one of the keys in `KIND_TO_FILE`
 * @returns {string}
 */
export default function load(kind) {
	const file = KIND_TO_FILE[kind];
	if (!file) throw new Error(`Unknown message kind: ${kind}`);
	return context.fs.readFileSync(context.path.join(self.paths.messagesDir(), file), "utf8");
}
