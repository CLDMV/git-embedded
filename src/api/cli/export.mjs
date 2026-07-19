import { self, context } from "@cldmv/slothlet/runtime";

export const spec = {
	command: "export",
	description:
		"Serialize the local-config registry to a manifest JSON (stdout by default). The manifest is a TRANSFER FILE — carry it out-of-band and NEVER commit it; committing child URLs defeats anonymous gitlinks.",
	options: [
		["-o <file>", "Write the manifest to <file> instead of stdout"],
		["--scan", "Record every present child (like 'record') before exporting"]
	],
	examples: ["$ git-embedded export", "$ git-embedded export -o children.json", "$ git-embedded export --scan -o children.json"]
};

/**
 * Append `relPath` to the repo's `.git/info/exclude` if not already listed, so a
 * manifest written inside the worktree is not accidentally staged.
 * @param {string} gitDir absolute git dir
 * @param {string} relPath worktree-relative path to exclude
 * @returns {boolean} true when a new line was added
 */
function addToExclude(gitDir, relPath) {
	const { fs, path } = context;
	const exclude = path.join(gitDir, "info", "exclude");
	let body = "";
	try {
		body = fs.readFileSync(exclude, "utf8");
	} catch {
		body = "";
	}
	const lines = body.split(/\r?\n/).map((l) => l.trim());
	if (lines.includes(relPath) || lines.includes(`/${relPath}`)) return false;
	fs.mkdirSync(path.dirname(exclude), { recursive: true });
	const prefix = body.length === 0 || body.endsWith("\n") ? "" : "\n";
	fs.appendFileSync(exclude, `${prefix}${relPath}\n`);
	return true;
}

export function run(opts = {}) {
	const { fs, path } = context;
	const cwd = process.cwd();
	const root = self.git.getRepoRoot(cwd) || cwd;

	if (opts.scan) self.embedded.record({ cwd });

	const entries = self.embedded.registry.entries(root);
	const manifest = self.embedded.manifest.build(entries);
	const text = self.embedded.manifest.serialize(manifest);

	const outFile = opts.o;
	if (!outFile) {
		process.stdout.write(text);
		return;
	}

	const abs = path.isAbsolute(outFile) ? outFile : path.resolve(cwd, outFile);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, text);
	self.report.success(`Wrote manifest to ${abs} (${Object.keys(manifest.children).length} children).`);
	self.report.warn("This manifest contains child URLs — do NOT commit it. Carry it out-of-band.");

	const rel = path.relative(root, abs);
	const insideWorktree = rel && !rel.startsWith("..") && !path.isAbsolute(rel);
	if (insideWorktree) {
		const gitDir = self.git.getGitDir(cwd);
		if (gitDir && addToExclude(gitDir, rel.split(path.sep).join("/"))) {
			self.report.plain(`  (added ${rel} to .git/info/exclude as a courtesy)`);
		}
	}
}

export default { spec, run };
