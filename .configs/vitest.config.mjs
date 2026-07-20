import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Anchor the project root to the package directory so include/exclude work no
// matter what cwd vitest is invoked from.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export default defineConfig({
	root,
	test: {
		include: ["tests/**/*.test.mjs"],
		exclude: ["node_modules", "reference/**"],
		environment: "node",
		testTimeout: 30000,
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
