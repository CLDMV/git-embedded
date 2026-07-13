import { self } from "@cldmv/slothlet/runtime";

export const spec = {
	command: "record",
	description:
		"Record the origin URL (and current branch) of each embedded child present on disk into the parent's LOCAL config registry, so a later export or re-restore does not have to re-derive it. The registry is never committed.",
	args: [["[paths...]", "Restrict to these gitlink paths (default: every child present on disk)"]],
	examples: ["$ git-embedded record", "$ git-embedded record tests vendor/foo"]
};

const LABEL = {
	recorded: (r) => `${r.path} → ${r.url}${r.branch ? ` (${r.branch})` : ""}`,
	"no-repo": (r) => `${r.path} not present on disk`,
	"no-origin": (r) => `${r.path} has no remote.origin.url`
};

export function run(paths = []) {
	const { results } = self.embedded.record({ cwd: process.cwd(), paths });

	if (!results.length) {
		self.report.plain("No embedded children present on disk to record.");
		return;
	}

	for (const r of results) {
		const line = LABEL[r.outcome] ? LABEL[r.outcome](r) : `${r.path}: ${r.outcome}`;
		if (r.outcome === "recorded") self.report.success(line);
		else self.report.warn(line);
	}

	const recorded = results.filter((r) => r.outcome === "recorded").length;
	self.report.plain("");
	self.report.success(`Recorded ${recorded} of ${results.length} into the local registry (not committed).`);
}

export default { spec, run };
