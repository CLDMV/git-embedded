import { context } from "@cldmv/slothlet/runtime";

const CONFIG_NAMES = ["lefthook.yml", "lefthook.yaml", ".lefthook.yml", ".lefthook.yaml"];

function readHead(p, n = 4) {
	try {
		return context.fs.readFileSync(p, "utf8").split(/\r?\n/).slice(0, n).join("\n");
	} catch {
		return null;
	}
}

/**
 * Detect Lefthook in a repo.
 *
 * @param {string} repoRoot
 * @param {string|null} gitDir
 * @returns {{kind:"lefthook",configFile:string|null,headerIn?:string}|null}
 */
export default function lefthook(repoRoot, gitDir) {
	if (!repoRoot) return null;
	const { fs, path } = context;
	const config = CONFIG_NAMES.map((c) => path.join(repoRoot, c)).find((p) => fs.existsSync(p));
	if (config) return { kind: "lefthook", configFile: config };
	if (gitDir) {
		const hooksDir = path.join(gitDir, "hooks");
		if (fs.existsSync(hooksDir)) {
			for (const f of fs.readdirSync(hooksDir)) {
				const head = readHead(path.join(hooksDir, f));
				if (head && /lefthook/i.test(head)) {
					return { kind: "lefthook", configFile: null, headerIn: path.join(hooksDir, f) };
				}
			}
		}
	}
	return null;
}
