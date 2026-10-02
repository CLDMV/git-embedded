/**
 *
 *	@Project: @cldmv/git-embedded
 *	@Filename: /.configs/vitest.config.mjs
 *	@Date: 2026-05-24T21:13:00-07:00 (1779682380)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:07-07:00 (1790968807)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Anchor the project root to the package directory so include/exclude work no
// matter what cwd vitest is invoked from.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export default defineConfig({
	root,
	test: {
		include: ["tests/**/*.test.vitest.mjs"],
		exclude: ["node_modules", "reference/**"],
		environment: "node",
		testTimeout: 30000,
		server: { deps: { inline: [/@cldmv\/slothlet/] } },
		// "dot" keeps CI logs to one character per test file instead of a full
		// "RUN vX.Y.Z" + per-file pass/fail block for every file — vitest's
		// non-interactive fallback (no TTY to redraw) otherwise reprints that
		// whole block per file on top of the final aggregate summary, which
		// dominates the log on a suite this size. The final "Test Files X
		// passed" / "Tests Y passed" summary is unaffected — every built-in
		// reporter prints it regardless of per-test verbosity.
		reporters: ["dot"],
		coverage: {
			provider: "v8",
			include: ["src/**"],
			exclude: [
				"**/*.json",
				"tests/**",
				// Windows-only elevation helpers — cannot execute on the Linux coverage runner.
				"src/api/link/elevate-windows.mjs",
				"src/lib/elevate-windows-child.mjs"
			],
			reporter: ["text", "html", "json-summary", "json"]
		}
	}
});
