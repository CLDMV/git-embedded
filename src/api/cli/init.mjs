import { self, context } from "@cldmv/slothlet/runtime";

export const spec = {
	command: "init",
	description: "Set up the current repo for embedded gitlinks: run install-hooks, then silence the 'embedded git repository' advice.",
	options: [
		["--no-symlinks", "Forwarded to install-hooks: use hard links instead of symbolic links."],
		["--yes", "Forwarded to install-hooks: skip confirmation prompts."],
		["--dispatcher-dir <path>", "Forwarded to install-hooks: override the default dispatcher directory."]
	],
	examples: ["$ git-embedded init", "$ git-embedded init --yes"]
};

export async function run(opts = {}) {
	await self.cli.installHooks.run(opts);

	const { spawnSync } = context;
	const cfg = spawnSync("git", ["config", "advice.addEmbeddedRepo", "false"], { encoding: "utf8" });
	if (cfg.status === 0) {
		self.report.success("Silenced 'embedded git repository' advice (git config advice.addEmbeddedRepo=false).");
	} else {
		self.report.warn(`Could not set git config advice.addEmbeddedRepo: ${cfg.stderr || cfg.stdout}`);
	}
}

export default { spec, run };
