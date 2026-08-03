import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getApi } from "./_setup.mjs";

const tmpRoots = [];

function mkRepoRoot() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-embedded-foreign-"));
	tmpRoots.push(dir);
	return dir;
}

afterEach(() => {
	while (tmpRoots.length) {
		const d = tmpRoots.pop();
		try {
			fs.rmSync(d, { recursive: true, force: true });
		} catch {
			// ignore
		}
	}
});

let api;
beforeAll(async () => {
	api = await getApi();
});

describe("foreign-hook-manager detection (api.detect.*)", () => {
	it("detects husky from .husky directory + package.json prepare", () => {
		const root = mkRepoRoot();
		fs.mkdirSync(path.join(root, ".husky"));
		fs.writeFileSync(
			path.join(root, "package.json"),
			JSON.stringify({ scripts: { prepare: "husky" }, devDependencies: { husky: "^9.0.0" } })
		);
		const out = api.detect.husky(root);
		expect(out).not.toBeNull();
		expect(out.kind).toBe("husky");
		expect(out.prepare).toBe("husky");
		expect(out.version).toBe("^9.0.0");
	});

	it("returns null when .husky is absent", () => {
		const root = mkRepoRoot();
		expect(api.detect.husky(root)).toBeNull();
	});

	it("detects lefthook from lefthook.yml", () => {
		const root = mkRepoRoot();
		fs.writeFileSync(path.join(root, "lefthook.yml"), "pre-commit:\n  commands:\n    a: echo a\n");
		const out = api.detect.lefthook(root, null);
		expect(out).not.toBeNull();
		expect(out.kind).toBe("lefthook");
		expect(out.configFile.endsWith("lefthook.yml")).toBe(true);
	});

	it("detects simple-git-hooks from package.json top-level key", () => {
		const root = mkRepoRoot();
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ "simple-git-hooks": { "pre-commit": "echo hi" } }));
		const out = api.detect.simpleGitHooks(root);
		expect(out).not.toBeNull();
		expect(out.kind).toBe("simple-git-hooks");
		expect(out.configIn).toBe("package.json");
	});

	it("detects pre-commit from .pre-commit-config.yaml", () => {
		const root = mkRepoRoot();
		fs.writeFileSync(path.join(root, ".pre-commit-config.yaml"), "repos:\n  - repo: local\n    hooks: []\n");
		const out = api.detect.preCommit(root, null);
		expect(out).not.toBeNull();
		expect(out.kind).toBe("pre-commit");
	});
});
