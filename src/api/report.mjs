import { self, context } from "@cldmv/slothlet/runtime";

const KIND_LABELS = {
	none: "No hook setup detected",
	"dispatcher-canonical-complete": "Canonical dispatcher (complete)",
	"dispatcher-missing-symlinks": "Canonical dispatcher (missing required entries)",
	"dispatcher-non-conforming": "Non-conforming dispatcher",
	husky: "Husky",
	lefthook: "Lefthook",
	"simple-git-hooks": "simple-git-hooks",
	"pre-commit": "pre-commit (Python)",
	"bare-githooks": "Bare hooks directory",
	"system-hookspath": "System-scope core.hooksPath",
	"init-templatedir": "init.templateDir set globally"
};

function fmtKv(label, value) {
	if (value == null || value === "") return null;
	return `  ${context.chalk.bold(label)}: ${value}`;
}

/**
 * User-facing output helpers — colorized status lines + the "Detected: …"
 * header rendered before each message file.
 *
 * @namespace api.report
 */

export function detectionHeader(result) {
	const { chalk } = context;
	const label = KIND_LABELS[result.kind] || result.kind;
	console.log(chalk.cyan.bold(`\nDetected: ${label}`));

	const { paths, signals, dispatcher, foreign, bare, subClassification } = result;
	const lines = [];
	if (paths) {
		if (paths.repoRoot) lines.push(fmtKv("Repo root", paths.repoRoot));
		if (paths.gitDir) lines.push(fmtKv("Git dir", paths.gitDir));
		if (paths.effectiveHooksPath) lines.push(fmtKv("Effective core.hooksPath", paths.effectiveHooksPath));
	}
	if (signals && signals.hooksPathScopes) {
		const s = signals.hooksPathScopes;
		const scope = (k, v) => (v ? `${k}=${v}` : null);
		const parts = [scope("system", s.system), scope("global", s.global), scope("local", s.local)].filter(Boolean);
		if (parts.length) lines.push(fmtKv("core.hooksPath scopes", parts.join("  ")));
	}
	if (signals && signals.initTemplateDir) lines.push(fmtKv("init.templateDir", signals.initTemplateDir));
	if (dispatcher && dispatcher.dispatcherPath) lines.push(fmtKv("Dispatcher", dispatcher.dispatcherPath));
	if (dispatcher && dispatcher.missing && dispatcher.missing.length) {
		lines.push(fmtKv("Missing entries", dispatcher.missing.join(", ")));
	}
	if (foreign && foreign.dir) lines.push(fmtKv("Tool directory", foreign.dir));
	if (foreign && foreign.configFile) lines.push(fmtKv("Config file", foreign.configFile));
	if (bare && bare.dir) lines.push(fmtKv("Hooks directory", bare.dir));
	if (subClassification && subClassification.dispatcherPath) {
		lines.push(fmtKv("System-path dispatcher", subClassification.dispatcherPath));
	}

	for (const l of lines.filter(Boolean)) console.log(l);
	console.log("");
}

export function message(kind) {
	const body = self.messages.load(kind);
	const rendered = context.renderMarkdown(body);
	/* v8 ignore next -- every messages/*.md file (plus empty/whitespace-only input) renders
	   with a trailing newline (verified), so the append branch isn't reached by the current
	   message set; marked doesn't guarantee a trailing newline universally, so the guard stays. */
	process.stdout.write(rendered.endsWith("\n") ? rendered : rendered + "\n");
}

export function success(line) {
	console.log(context.chalk.green(`✓ ${line}`));
}

export function warn(line) {
	console.log(context.chalk.yellow(`! ${line}`));
}

export function error(line) {
	console.error(context.chalk.red(`✗ ${line}`));
}

export function plain(line = "") {
	console.log(line);
}
