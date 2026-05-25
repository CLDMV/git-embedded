import { self } from "@cldmv/slothlet/runtime";

export const spec = {
	command: "install-template",
	description: "Install git-embedded's hook scripts into git's init.templateDir/hooks so new repos start with them.",
	options: [
		["--template-dir <path>", "Override the template directory (default: git config --global init.templateDir)."],
		["--force", "Overwrite existing hook files even if not owned by git-embedded."],
		["--yes", "Skip confirmation prompts."]
	],
	examples: ["$ git-embedded install-template", "$ git-embedded install-template --template-dir ~/.config/git/template"]
};

export async function run(opts = {}) {
	const templateDir = opts.templateDir || self.git.getInitTemplateDir();
	if (!templateDir) {
		self.report.error("git config --global init.templateDir is not set, and no --template-dir was provided.");
		self.report.plain("Set one first, e.g.: git config --global init.templateDir ~/.config/git/template");
		process.exit(2);
	}

	self.report.plain(`Template directory: ${templateDir}`);
	self.report.plain(`Template hooks directory: ${templateDir}/hooks`);
	self.report.plain("");
	self.report.warn("Installing here only affects repos created or cloned AFTER this point.");
	self.report.plain("Existing repos still need `git-embedded install-hooks` run individually.");
	self.report.plain("");

	const ok = await self.prompt.confirm(`Install git-embedded hook scripts into ${templateDir}/hooks?`, {
		defaultYes: false,
		yes: opts.yes
	});
	if (!ok) {
		self.report.warn("Declined.");
		return;
	}

	const out = await self.install.template(templateDir, { force: opts.force });
	if (out.installed.length > 0) self.report.success(`Installed template hooks: ${out.installed.join(", ")}`);
	for (const s of out.skipped) self.report.warn(`Skipped ${s.name}: ${s.reason}`);
}

export default { spec, run };
