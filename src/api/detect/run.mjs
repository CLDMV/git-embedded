import { self, context } from "@cldmv/slothlet/runtime";

/**
 * Inspect `cwd` and return a structured classification. Foreign-manager
 * checks (Husky / Lefthook / simple-git-hooks / pre-commit) take precedence
 * over hooks-dir classification; system-scope `core.hooksPath` is reported
 * with its sub-classification; otherwise the effective hooks dir is
 * classified; otherwise `init.templateDir` fallback or "none".
 *
 * @param {string} [cwd]
 */
export default function run(cwd = process.cwd()) {
	const { fs, path } = context;
	const repoRoot = self.git.getRepoRoot(cwd);
	const gitDir = self.git.getGitDir(cwd);
	const scopes = self.git.getAllHooksPathScopes(cwd);
	const effectiveHooksPath = self.git.getEffectiveHooksPath(cwd);
	const initTemplateDir = self.git.getInitTemplateDir();

	const paths = { repoRoot, gitDir, effectiveHooksPath, initTemplateDir };
	const signals = { hooksPathScopes: scopes, initTemplateDir };

	if (repoRoot) {
		const husky = self.detect.husky(repoRoot);
		if (husky) return { kind: "husky", paths, signals, foreign: husky, action: "refuse" };

		const lefthook = self.detect.lefthook(repoRoot, gitDir);
		if (lefthook) return { kind: "lefthook", paths, signals, foreign: lefthook, action: "refuse" };

		const sgh = self.detect.simpleGitHooks(repoRoot);
		if (sgh) return { kind: "simple-git-hooks", paths, signals, foreign: sgh, action: "refuse" };

		const preCommit = self.detect.preCommit(repoRoot, gitDir);
		if (preCommit) return { kind: "pre-commit", paths, signals, foreign: preCommit, action: "refuse" };
	}

	const systemPath = scopes.system;
	if (systemPath && !scopes.global && !scopes.local) {
		const sub = self.detect.dispatcher(effectiveHooksPath || systemPath);
		return {
			kind: "system-hookspath",
			paths,
			signals,
			dispatcher: sub.kind.startsWith("dispatcher") ? sub : null,
			subClassification: sub,
			action: sub.kind === "dispatcher-canonical-complete" ? "install" : "refuse"
		};
	}

	if (effectiveHooksPath) {
		const sub = self.detect.dispatcher(effectiveHooksPath);
		if (sub.kind === "dispatcher-canonical-complete") {
			return { kind: "dispatcher-canonical-complete", paths, signals, dispatcher: sub, action: "install" };
		}
		if (sub.kind === "dispatcher-missing-symlinks") {
			return { kind: "dispatcher-missing-symlinks", paths, signals, dispatcher: sub, action: "heal-then-install" };
		}
		if (sub.kind === "dispatcher-non-conforming") {
			return { kind: "dispatcher-non-conforming", paths, signals, dispatcher: sub, action: "refuse" };
		}
		if (sub.kind === "bare-githooks") {
			return { kind: "bare-githooks", paths, signals, bare: sub, action: "refuse" };
		}
	}

	if (initTemplateDir && fs.existsSync(path.join(initTemplateDir, "hooks"))) {
		return { kind: "init-templatedir", paths, signals, templateDir: initTemplateDir, action: "suggest-dispatcher" };
	}

	return { kind: "none", paths, signals, action: "suggest-dispatcher" };
}
