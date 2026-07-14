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
 * Whether the target path blocks a fresh clone. A missing path is fine, and an
 * empty REAL directory is fine (a fresh clone of the parent materializes each
 * gitlink as an empty dir). Everything else is refused: a directory with
 * contents, an existing repo, a file, an unreadable directory, or a SYMLINK —
 * even one pointing at an empty dir, since cloning through it would write
 * outside the repo. lstat so links are seen (and broken links caught), never
 * followed.
 * @param {string} target
 * @returns {boolean}
 */
function blocksClone(target) {
	const { fs } = context;
	let st;
	try {
		st = fs.lstatSync(target);
	} catch (err) {
		// Only a missing path (ENOENT) is safe — git clone creates it.
		return err.code !== "ENOENT";
	}
	if (st.isSymbolicLink() || !st.isDirectory()) return true;
	try {
		return fs.readdirSync(target).length > 0;
	} catch {
		return true; // unreadable directory
	}
}

export function run(localPath, remoteUrl) {
	const { spawnSync, path } = context;

	// Normalize to the repo-root-relative, slash-normalized gitlink path — the
	// key restore/gitlinks/export all use. "./tests" or "tests/" must record as
	// "tests", and a target outside the worktree is refused outright.
	const root = self.git.getRepoRoot() || process.cwd();
	const rel = path.relative(root, path.resolve(process.cwd(), localPath)).split(path.sep).join("/");
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
		self.report.error(`${localPath} is outside the repository worktree — link inside the parent repo.`);
		process.exit(2);
	}

	if (blocksClone(localPath)) {
		self.report.error(`${localPath} exists and is not an empty directory. Remove it or pick a different path before linking.`);
		process.exit(2);
	}

	self.report.plain(`Cloning ${remoteUrl} into ${rel}…`);
	// `--` ends option parsing: a URL or path starting with "-" must never be
	// interpreted as a git option (e.g. --upload-pack).
	const clone = spawnSync("git", ["clone", "--", remoteUrl, localPath], { stdio: "inherit" });
	if (clone.status !== 0) {
		self.report.error(`git clone exited with status ${clone.status}`);
		process.exit(clone.status || 1);
	}

	const add = spawnSync("git", ["add", "--", localPath], { stdio: "inherit" });
	if (add.status !== 0) {
		self.report.error(`git add ${localPath} exited with status ${add.status}`);
		process.exit(add.status || 1);
	}

	// Record the URL + branch into the parent's LOCAL config registry (never
	// committed) so a later restore/export already knows this child — keyed by
	// the NORMALIZED gitlink path so day-2 restore/export find it.
	self.embedded.registry.recordOne(rel, root);

	self.report.success(`Staged gitlink at ${rel} (no .gitmodules entry written).`);
	self.report.plain("Commit when ready: git commit -m 'embed <name>'");
}

export default { spec, run };
