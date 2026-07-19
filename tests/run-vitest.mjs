/**
 * @fileoverview OOM-safe Vitest runner for git-embedded — delegates to
 * @cldmv/vitest-runner, which spawns each test file in its own child process and
 * (under coverage) uses a blob-per-file + `--mergeReports` strategy so a single
 * process never holds coverage data for the whole suite. Mirrors how @cldmv/slothlet
 * runs its suite.
 *
 * Usage:
 *   node tests/run-vitest.mjs                 # run all tests
 *   node tests/run-vitest.mjs --coverage      # with coverage (verbose)
 *   node tests/run-vitest.mjs --coverage-quiet# with coverage (progress bar + summary)
 *   node tests/run-vitest.mjs <pattern...>    # filter by path/name
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "@cldmv/vitest-runner";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);

const coverageQuiet = argv.includes("--coverage-quiet");
const coverage = coverageQuiet || argv.includes("--coverage");
// Positional (non-flag) args are test patterns; everything else is forwarded to vitest.
const testPatterns = argv.filter((a) => !a.startsWith("-"));
const passthrough = argv.filter((a) => a.startsWith("-") && a !== "--coverage" && a !== "--coverage-quiet");

const code = await run({
	cwd: root,
	testDir: "tests",
	vitestConfig: ".configs/vitest.config.mjs",
	// git-embedded uses the plain `*.test.mjs` convention rather than `*.test.vitest.mjs`.
	testFilePattern: /\.test\.mjs$/,
	testPatterns,
	workers: process.env.VITEST_WORKERS ? parseInt(process.env.VITEST_WORKERS, 10) : 4,
	coverageQuiet,
	vitestArgs: [...(coverage ? ["--coverage"] : []), ...passthrough],
	nodeEnv: process.env.NODE_ENV || "development"
});
process.exit(code);
