import { self } from "@cldmv/slothlet/runtime";

export const spec = {
	command: "sync",
	description:
		"Move already-present embedded children to the pins in the parent's HEAD (day-2, after pulling the parent — sync never touches the parent itself). Clean children follow the pin: the registered branch fast-forwards, a detached child snaps. Dirty children, commits beyond the pin, and unregistered branches are your work — reported and left alone.",
	args: [["[paths...]", "Restrict to these gitlink paths (default: every embedded gitlink)"]],
	options: [
		["--skip <paths>", "Comma-separated gitlink paths to skip"],
		["--dry-run", "Report what would happen without fetching or moving anything"]
	],
	examples: ["$ git pull && git-embedded sync", "$ git-embedded sync tests", "$ git-embedded sync --dry-run"]
};

const LABEL = {
	synced: (r) =>
		`${r.dryRun ? "would sync" : "synced"} ${r.path} → ${r.sha.slice(0, 12)}${r.branch ? ` (branch ${r.branch})` : " (detached)"}${r.note ? ` — ${r.note}` : ""}`,
	"in-sync": (r) => `${r.path} already at pin`,
	dirty: (r) => `${r.path} ${r.note}`,
	ahead: (r) => `${r.path} ${r.note}`,
	"unregistered-branch": (r) => `${r.path} ${r.note}`,
	"pin-unavailable": (r) => `${r.path} pin-unavailable${r.note ? ` — ${r.note}` : ""}`,
	"sync-failed": (r) => `${r.path} sync-failed${r.note ? ` — ${r.note}` : ""}`,
	skipped: (r) => `${r.path} skipped`,
	"no-repo": (r) => `${r.path} ${r.note}`
};

export function run(paths = [], opts = {}) {
	const skip =
		typeof opts.skip === "string"
			? opts.skip
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean)
			: [];

	const { results, exitCode } = self.embedded.sync({
		cwd: process.cwd(),
		paths,
		skip,
		dryRun: Boolean(opts.dryRun)
	});

	if (!results.length) {
		self.report.plain("No embedded children present to sync.");
		process.exit(0);
	}

	for (const r of results) {
		const line = LABEL[r.outcome] ? LABEL[r.outcome](r) : `${r.path}: ${r.outcome}`;
		if (r.outcome === "synced") self.report.success(line);
		else if (r.outcome === "pin-unavailable" || r.outcome === "sync-failed") self.report.error(line);
		else self.report.warn(line);
	}

	// Each outcome lands in exactly one bucket; "left alone" collects the
	// deliberate your-work outcomes, which are not failures.
	const synced = results.filter((r) => r.outcome === "synced").length;
	const unchanged = results.filter((r) => r.outcome === "in-sync").length;
	const leftAlone = results.filter((r) => ["dirty", "ahead", "unregistered-branch"].includes(r.outcome)).length;
	const skipped = results.filter((r) => ["skipped", "no-repo"].includes(r.outcome)).length;
	const failed = results.filter((r) => r.outcome === "pin-unavailable" || r.outcome === "sync-failed").length;
	self.report.plain("");
	self.report.plain(
		`${synced} ${opts.dryRun ? "syncable" : "synced"}, ${unchanged} unchanged, ${leftAlone} left alone${skipped ? `, ${skipped} skipped` : ""}, ${failed} failed.`
	);
	process.exit(exitCode);
}

export default { spec, run };
