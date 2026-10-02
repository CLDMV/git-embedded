/**
 *
 *	@Project: @cldmv/git-embedded
 *	@Filename: /src/api/install/template.mjs
 *	@Date: 2026-05-24T21:13:00-07:00 (1779682380)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:21-07:00 (1790968821)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { self, context } from "@cldmv/slothlet/runtime";

/**
 * Install the package's hook scripts into a `git init.templateDir/hooks`
 * directory so new repos start with them.
 *
 * @param {string} templateDir
 * @param {object} [opts]
 * @param {boolean} [opts.force]
 */
export default function template(templateDir, opts = {}) {
	const { fs, path } = context;
	fs.mkdirSync(path.join(templateDir, "hooks"), { recursive: true });
	return self.install.hooks("install", templateDir, opts);
}
