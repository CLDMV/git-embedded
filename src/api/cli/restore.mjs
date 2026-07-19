import { self } from "@cldmv/slothlet/runtime";

export const spec = {
	command: "restore",
	description:
		"Clone missing embedded child repos and check out their pinned SHAs. Each child's URL is resolved strictest-first — local config, a manifest (--from), --base, then the parent's origin convention — and every clone is SHA-verified so a wrong guess fails closed. A branch from the registry/manifest (or inferred when exactly one origin branch contains the pin) puts the child ON that branch at the pin; otherwise the checkout is detached.",
	args: [["[paths...]", "Restrict to these gitlink paths (default: every embedded gitlink)"]],
	options: [
		["--from <manifest>", "Read child URLs from a manifest JSON file (a transfer file; never committed)"],
		["--base <url-base>", "Derive each child URL as <url-base>/<basename>.git"],
		["--skip <paths>", "Comma-separated gitlink paths to skip (for a partial restore without access to a private child)"],
		["--dry-run", "Report what would happen without cloning or writing config"]
	],
	examples: [
		"$ git-embedded restore",
		"$ git-embedded restore tests",
		"$ git-embedded restore --from children.json",
		"$ git-embedded restore --base git@example.com:org",
		"$ git-embedded restore --skip tests --dry-run"
	]
};

const LABEL = {
	restored: (r) => `${r.dryRun ? "would restore" : "restored"} ${r.path} from ${r.source} (${r.url})${r.branch ? ` on branch ${r.branch}` : ""}`,
	"already-present": (r) => `${r.path} already present`,
	skipped: (r) => `${r.path} skipped`,
	unresolved: (r) => `${r.path} unresolved${r.note ? ` — ${r.note}` : ""}`,
	"pinned-mismatch": (r) => `${r.path} pinned-mismatch${r.note ? ` — ${r.note}` : ""}`
};

export function run(paths = [], opts = {}) {
	const skip =
		typeof opts.skip === "string"
			? opts.skip
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean)
			: [];

	const { results, exitCode } = self.embedded.restore({
		cwd: process.cwd(),
		paths,
		from: opts.from || null,
		base: opts.base || null,
		skip,
		dryRun: Boolean(opts.dryRun)
	});

	if (!results.length) {
		self.report.plain("No embedded gitlinks in HEAD.");
		process.exit(0);
	}

	for (const r of results) {
		const line = LABEL[r.outcome] ? LABEL[r.outcome](r) : `${r.path}: ${r.outcome}`;
		if (r.outcome === "restored") self.report.success(line);
		else if (r.outcome === "unresolved" || r.outcome === "pinned-mismatch") self.report.error(line);
		else self.report.warn(line);
	}

	// Count each outcome into exactly one bucket — "unchanged" is only
	// already-present, never a failure or a skip counted twice.
	const restored = results.filter((r) => r.outcome === "restored").length;
	const unchanged = results.filter((r) => r.outcome === "already-present").length;
	const skipped = results.filter((r) => r.outcome === "skipped").length;
	const failed = results.filter((r) => r.outcome === "unresolved" || r.outcome === "pinned-mismatch").length;
	self.report.plain("");
	self.report.plain(
		`${restored} ${opts.dryRun ? "resolvable" : "restored"}, ${unchanged} unchanged${skipped ? `, ${skipped} skipped` : ""}, ${failed} failed.`
	);
	process.exit(exitCode);
}

export default { spec, run };
