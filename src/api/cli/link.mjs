import { self, context } from "@cldmv/slothlet/runtime";

export const spec = {
	command: "link",
	description:
		"Clone a remote repo into <local-path> and stage it as an anonymous gitlink. Does NOT commit (you may want to stage other things in the same commit).",
	args: [
		["<local-path>", "Where to clone the child repo (created if missing; an empty gitlink dir is accepted)"],
		["<remote-url>", "The child repo's clone URL (will NOT be recorded in .gitmodules)"]
	],
	examples: [
		"$ git-embedded link tests git@example.com:org/private-tests.git",
		"$ git-embedded link vendor/foo https://github.com/org/foo.git"
	]
};

/**
 * Whether `dir` blocks a fresh clone. A missing path is fine, and an empty
 * directory is fine (a fresh clone of the parent materializes each gitlink as
 * an empty dir). A directory with contents, an existing repo, a FILE at the
 * path, or an unreadable directory — all refused.
 * @param {string} dir
 * @returns {boolean}
 */
function isNonEmpty(dir) {
	const { fs } = context;
	try {
		return fs.readdirSync(dir).length > 0;
	} catch (err) {
		// A file (ENOTDIR) or an unreadable directory must be refused up-front —
		// cloning into it fails confusingly (or worse). Only a missing path
		// (ENOENT) is safe to treat as empty: git clone creates it.
		return err.code !== "ENOENT";
	}
}

export function run(localPath, remoteUrl) {
	const { fs, spawnSync } = context;

	if (fs.existsSync(localPath) && isNonEmpty(localPath)) {
		self.report.error(`${localPath} already exists and is not empty. Remove it or pick a different path before linking.`);
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

	// Record the URL + branch into the parent's LOCAL config registry (never
	// committed) so a later restore/export already knows this child.
	const root = self.git.getRepoRoot() || process.cwd();
	self.embedded.registry.recordOne(localPath, root);

	self.report.success(`Staged gitlink at ${localPath} (no .gitmodules entry written).`);
	self.report.plain("Commit when ready: git commit -m 'embed <name>'");
}

export default { spec, run };
