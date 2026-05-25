import { self, context } from "@cldmv/slothlet/runtime";
import { CancelledByUser } from "../link/batch.mjs";

export const spec = {
	command: "install-hooks",
	description: "Install git-embedded's hook scripts into this repo, bootstrapping a global dispatcher if needed.",
	options: [
		["--no-symlinks", "Use hard links instead of symbolic links (avoids the Windows UAC prompt)."],
		["--yes", "Skip confirmation prompts; assume yes for any modification."],
		["--dispatcher-dir <path>", "Override the default dispatcher directory (~/.config/git/hooks)."]
	],
	examples: [
		"$ git-embedded install-hooks",
		"$ git-embedded install-hooks --no-symlinks",
		"$ git-embedded install-hooks --yes"
	]
};

export async function run(opts = {}) {
	const result = await self.detect.run(process.cwd());
	self.report.detectionHeader(result);
	self.report.message(result.kind);
	self.report.plain("");

	switch (result.action) {
		case "install":
			await installRepoOnly(result);
			return;
		case "heal-then-install":
			await healAndInstall(result, opts);
			return;
		case "suggest-dispatcher":
			await bootstrapAndInstall(result, opts);
			return;
		case "refuse":
			self.report.error(`Refusing to install over ${result.kind}. See the guidance above for manual integration paths.`);
			process.exit(2);
			return;
		default:
			self.report.error(`Unknown detection action: ${result.action}`);
			process.exit(2);
	}
}

async function installRepoOnly(result) {
	const gitDir = result.paths.gitDir;
	if (!gitDir) {
		self.report.error("Not inside a git repository — run from inside the repo you want to install hooks for.");
		process.exit(2);
	}
	const out = await self.install.hooks("install", gitDir);
	if (out.installed.length > 0) self.report.success(`Installed per-repo hooks: ${out.installed.join(", ")}`);
	for (const s of out.skipped) self.report.warn(`Skipped ${s.name}: ${s.reason}`);
}

async function healAndInstall(result, opts) {
	const missing = result.dispatcher.missing;
	self.report.plain(context.chalk.bold("Proposed heal:"));
	self.report.plain(`  Dispatcher: ${result.dispatcher.dispatcherPath}`);
	self.report.plain(`  Add entries: ${missing.join(", ")}`);
	self.report.plain(`  Mechanism: ${opts.noSymlinks ? "hardlink" : "symlink (UAC on Windows when not elevated)"}`);
	self.report.plain("");
	const ok = await self.prompt.confirm("Add the missing entries?", { defaultYes: false, yes: opts.yes });
	if (!ok) {
		self.report.warn("Heal declined. Re-run after adding the entries yourself; see the message above.");
		process.exit(2);
	}
	try {
		const linkResult = await self.install.dispatcher(
			"heal",
			{ dispatcherPath: result.dispatcher.dispatcherPath, missing },
			{ noSymlinks: opts.noSymlinks }
		);
		self.report.success(`Healed ${linkResult.created.length} entries`);
		if (linkResult.fallbackToCopy.length > 0) self.report.warn(`Filesystem fallback to copy for ${linkResult.fallbackToCopy.length} entries`);
	} catch (err) {
		if (err instanceof CancelledByUser) {
			self.report.error(err.message);
			self.report.plain("To heal without symlinks (no UAC prompt), re-run with --no-symlinks.");
			process.exit(2);
		}
		throw err;
	}
	await installRepoOnly(result);
}

async function bootstrapAndInstall(result, opts) {
	const dir = opts.dispatcherDir || self.paths.defaultGlobalDispatcherDir();
	self.report.plain(context.chalk.bold("Proposed dispatcher install:"));
	self.report.plain(`  Directory: ${dir}`);
	self.report.plain(`  Link mechanism: ${opts.noSymlinks ? "hardlink" : "symlink (UAC on Windows when not elevated)"}`);
	self.report.plain(`  Global config: git config --global core.hooksPath ${dir}`);
	self.report.plain("");
	const ok = await self.prompt.confirm("Install the dispatcher and set global core.hooksPath?", { defaultYes: false, yes: opts.yes });
	if (!ok) {
		self.report.warn("Dispatcher install declined. Falling back to per-repo install.");
		if (result.paths.gitDir) await installRepoOnly(result);
		return;
	}
	try {
		const out = await self.install.dispatcher("bootstrap", { dir }, { noSymlinks: opts.noSymlinks });
		self.report.success(`Dispatcher installed at ${out.dispatcherPath}`);
		const mechs = new Set(out.created.map((c) => c.mechanism));
		self.report.plain(`  Created ${out.created.length} entries (${[...mechs].join(", ")})`);
		if (out.fallbackToCopy.length > 0) self.report.warn(`Filesystem fallback to copy for ${out.fallbackToCopy.length} entries`);
		const gitConfig = context.spawnSync("git", ["config", "--global", "core.hooksPath", dir], { encoding: "utf8" });
		if (gitConfig.status !== 0) {
			self.report.error(`git config --global core.hooksPath failed: ${gitConfig.stderr || gitConfig.stdout}`);
			process.exit(1);
		}
		self.report.success(`Set git config --global core.hooksPath ${dir}`);
	} catch (err) {
		if (err instanceof CancelledByUser) {
			self.report.error(err.message);
			self.report.plain("To install without symlinks (no UAC prompt), re-run with --no-symlinks.");
			process.exit(2);
		}
		throw err;
	}
	if (result.paths.gitDir) await installRepoOnly(result);
	else self.report.warn("Not inside a git repo — skipping per-repo hook install.");
}

export default { spec, run };
