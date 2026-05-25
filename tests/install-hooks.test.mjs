import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getApi } from "./_setup.mjs";

const tmpRoots = [];

function mkTmp() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-embedded-install-"));
	tmpRoots.push(dir);
	return dir;
}

let originalEnv;

beforeEach(() => {
	originalEnv = { ...process.env };
	const stateDir = mkTmp();
	process.env.XDG_STATE_HOME = stateDir;
	if (process.platform === "win32") process.env.LOCALAPPDATA = stateDir;
});

afterEach(() => {
	process.env = originalEnv;
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

describe("api.install.hooks", () => {
	it("installs the four package hooks and skips foreign existing files", async () => {
		const gitDir = mkTmp();
		fs.mkdirSync(path.join(gitDir, "hooks"));
		// Pre-existing foreign hook should be left alone.
		fs.writeFileSync(path.join(gitDir, "hooks", "post-checkout"), "#!/bin/sh\n# someone else's hook\n");

		const out = await api.install.hooks("install", gitDir);

		const installed = Array.from(out.installed);
		expect(installed).toContain("post-merge");
		expect(installed).toContain("post-rewrite");
		expect(installed).toContain("reference-transaction");
		expect(installed).not.toContain("post-checkout");
		const skipped = Array.from(out.skipped).map((s) => s.name);
		expect(skipped).toContain("post-checkout");

		for (const name of ["post-merge", "post-rewrite", "reference-transaction"]) {
			const body = fs.readFileSync(path.join(gitDir, "hooks", name), "utf8");
			expect(body.startsWith("#!/usr/bin/env bash")).toBe(true);
			expect(body).toContain("git-embedded");
		}
	});

	it("overwrites existing git-embedded hooks on second install", async () => {
		const gitDir = mkTmp();
		await api.install.hooks("install", gitDir);
		fs.writeFileSync(path.join(gitDir, "hooks", "post-merge"), "#!/bin/sh\n# git-embedded stale\n");
		const out = await api.install.hooks("install", gitDir);
		expect(Array.from(out.installed)).toContain("post-merge");
		const body = fs.readFileSync(path.join(gitDir, "hooks", "post-merge"), "utf8");
		expect(body).toContain("update-embedded-repos");
	});

	it("writes one transaction-log entry per installed hook", async () => {
		const gitDir = mkTmp();
		await api.install.hooks("install", gitDir);
		const entries = await api.log.read();
		const ours = entries.filter((e) => e.op === "install-repo-hook" && e.path.startsWith(gitDir));
		expect(ours.length).toBe(4);
		expect(fs.existsSync(api.log.path())).toBe(true);
	});
});

describe("api.install.hooks uninstall", () => {
	it("removes only the hooks owned by git-embedded", async () => {
		const gitDir = mkTmp();
		await api.install.hooks("install", gitDir);
		fs.writeFileSync(path.join(gitDir, "hooks", "pre-commit"), "#!/bin/sh\necho foreign\n");
		const out = await api.install.hooks("uninstall", gitDir);
		const removed = Array.from(out.removed);
		for (const hook of ["post-checkout", "post-merge", "post-rewrite", "reference-transaction"]) {
			expect(removed).toContain(hook);
		}
		expect(fs.existsSync(path.join(gitDir, "hooks", "pre-commit"))).toBe(true);
	});
});
