import { self, context } from "@cldmv/slothlet/runtime";

export const spec = {
	command: "link",
	description:
		"Clone a remote repo into <local-path> and stage it as an anonymous gitlink. Does NOT commit (you may want to stage other things in the same commit).",
	args: [
		["<local-path>", "Where to clone the child repo (created if missing)"],
		["<remote-url>", "The child repo's clone URL (will NOT be recorded in .gitmodules)"]
	],
	examples: [
		"$ git-embedded link tests git@example.com:org/private-tests.git",
		"$ git-embedded link vendor/foo https://github.com/org/foo.git"
	]
};

export function run(localPath, remoteUrl) {
	const { fs, spawnSync } = context;

	if (fs.existsSync(localPath)) {
		self.report.error(`${localPath} already exists. Remove it or pick a different path before linking.`);
		process.exit(2);
	}

	self.report.plain(`Cloning ${remoteUrl} into ${localPath}…`);
	const clone = spawnSync("git", ["clone", remoteUrl, localPath], { stdio: "inherit" });
	if (clone.status !== 0) {
		self.report.error(`git clone exited with status ${clone.status}`);
		process.exit(clone.status || 1);
	}

	const add = spawnSync("git", ["add", localPath], { stdio: "inherit" });
	if (add.status !== 0) {
		self.report.error(`git add ${localPath} exited with status ${add.status}`);
		process.exit(add.status || 1);
	}

	self.report.success(`Staged gitlink at ${localPath} (no .gitmodules entry written).`);
	self.report.plain("Commit when ready: git commit -m 'embed <name>'");
}

export default { spec, run };
