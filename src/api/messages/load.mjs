import { self, context } from "@cldmv/slothlet/runtime";

const KIND_TO_FILE = {
	none: "setup-none.md",
	"dispatcher-canonical-complete": "setup-dispatcher-canonical-complete.md",
	"dispatcher-missing-symlinks": "setup-dispatcher-missing-symlinks.md",
	"dispatcher-non-conforming": "setup-dispatcher-non-conforming.md",
	husky: "setup-husky.md",
	lefthook: "setup-lefthook.md",
	"simple-git-hooks": "setup-simple-git-hooks.md",
	"pre-commit": "setup-pre-commit.md",
	"bare-githooks": "setup-bare-githooks.md",
	"system-hookspath": "setup-system-hookspath.md",
	"init-templatedir": "setup-init-templatedir.md"
};

/**
 * Read the markdown body for a detection classification kind, verbatim.
 *
 * @param {string} kind one of the keys in `KIND_TO_FILE`
 * @returns {string}
 */
export default function load(kind) {
	const file = KIND_TO_FILE[kind];
	if (!file) throw new Error(`Unknown message kind: ${kind}`);
	return context.fs.readFileSync(context.path.join(self.paths.messagesDir(), file), "utf8");
}
