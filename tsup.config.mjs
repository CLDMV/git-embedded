/**
 *
 *	@Project: @cldmv/git-embedded
 *	@Filename: /tsup.config.mjs
 *	@Date: 2026-11-07T22:27:48-08:00 (1794119268)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-08T00:15:18-08:00 (1794125718)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview Builds dist/ from src/, file by file.
 *
 * slothlet discovers the API by walking the api/ folder at runtime, so the
 * build keeps every file at the same relative path (`bundle: false`):
 * src/api/** → dist/api/**, src/lib/** → dist/lib/**, and the CLI
 * src/bin/git-embedded.mjs → dist/bin/git-embedded.mjs ("bin" in
 * package.json). Runtime dependencies stay external. esbuild keeps the
 * CLI's shebang line.
 */
import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/**/*.mjs"],
	outDir: "dist",
	bundle: false,
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
