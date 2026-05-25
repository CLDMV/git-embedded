import { context } from "@cldmv/slothlet/runtime";

function run(args, opts = {}) {
	const res = context.spawnSync("git", args, { encoding: "utf8", ...opts });
	return { code: res.status ?? 1, stdout: (res.stdout || "").trim(), stderr: (res.stderr || "").trim() };
}

/**
 * Git inspection helpers — config lookup at each scope, repo-root / git-dir
 * discovery, effective core.hooksPath resolution. All read-only.
 *
 * @namespace api.git
 */

export function getConfig(key, scope) {
	const args = ["config"];
	if (scope) args.push(`--${scope}`);
	args.push("--get", key);
	const res = run(args);
	return res.code === 0 ? res.stdout : null;
}

export function getRepoRoot(cwd = process.cwd()) {
	const res = run(["rev-parse", "--show-toplevel"], { cwd });
	return res.code === 0 ? res.stdout : null;
}

export function getGitDir(cwd = process.cwd()) {
	const res = run(["rev-parse", "--absolute-git-dir"], { cwd });
	return res.code === 0 ? res.stdout : null;
}

export function getEffectiveHooksPath(cwd = process.cwd()) {
	const { path, os } = context;
	const res = context.spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd, encoding: "utf8" });
	if (res.status !== 0) return null;
	const raw = (res.stdout || "").trim();
	if (!raw) return null;
	const expanded = raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw;
	if (path.isAbsolute(expanded)) return expanded;
	const root = getRepoRoot(cwd);
	return root ? path.resolve(root, expanded) : path.resolve(cwd, expanded);
}

export function getAllHooksPathScopes(cwd = process.cwd()) {
	void cwd;
	return {
		system: getConfig("core.hooksPath", "system"),
		global: getConfig("core.hooksPath", "global"),
		local: getConfig("core.hooksPath", "local")
	};
}

export function getInitTemplateDir() {
	const raw = getConfig("init.templateDir", "global");
	if (!raw) return null;
	const { path, os } = context;
	return raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw;
}
