import { self } from "@cldmv/slothlet/runtime";

export const spec = {
	command: "uninstall-hooks",
	description: "Remove git-embedded's hook scripts from this repo's .git/hooks directory. Leaves other hooks untouched.",
	examples: ["$ git-embedded uninstall-hooks"]
};

export async function run() {
	const gitDir = self.git.getGitDir(process.cwd());
	if (!gitDir) {
		self.report.error("Not inside a git repository.");
		process.exit(2);
	}
	const out = await self.install.hooks("uninstall", gitDir);
	if (out.removed.length === 0) self.report.plain("No git-embedded hooks found in this repo.");
	else self.report.success(`Removed per-repo hooks: ${out.removed.join(", ")}`);
	for (const k of out.kept) self.report.warn(`Left ${k.name} in place: ${k.reason}`);
}

export default { spec, run };
