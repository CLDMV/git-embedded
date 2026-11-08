/**
 *
 *	@Project: @cldmv/git-embedded
 *	@Filename: /tsup.config.mjs
 *	@Date: 2026-11-07T22:27:48-08:00 (1794119268)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-07T22:29:03-08:00 (1794119343)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview Builds the CLI: src/bin/git-embedded.mjs → bin/git-embedded.mjs.
 *
 * bin/ is the published path ("bin" in package.json) and a build artifact, not
 * tracked in git. The CLI only imports packages (runtime dependencies stay
 * external), and it loads the slothlet API from src/api/ at runtime, which is
 * why src/ still ships in `files`. esbuild keeps the shebang line.
 */
import { defineConfig } from "tsup";

export default defineConfig({
	entry: { "git-embedded": "src/bin/git-embedded.mjs" },
	outDir: "bin",
	format: ["esm"],
	target: "node22",
	platform: "node",
	splitting: false,
	sourcemap: false,
	dts: false,
	minify: true,
	keepNames: true,
	removeNodeProtocol: false,
	clean: true,
	outExtension() {
		return { js: ".mjs" };
	}
});
