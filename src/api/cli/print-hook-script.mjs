import { self, context } from "@cldmv/slothlet/runtime";

const NAME_TO_SOURCE = {
	"post-checkout": "update-embedded-repos",
	"post-merge": "update-embedded-repos",
	"post-rewrite": "update-embedded-repos",
	"reference-transaction": "reference-transaction",
	"update-embedded-repos": "update-embedded-repos",
	"pre-push": "pre-push",
	_dispatch: "_dispatch.template",
	dispatcher: "_dispatch.template"
};

export const spec = {
	command: "print-hook-script",
	description: "Print the contents of a packaged hook script to stdout. Useful for bring-your-own integrations.",
	args: [["<name>", "Hook name (e.g. post-checkout, reference-transaction, update-embedded-repos, _dispatch)"]],
	examples: [
		"$ git-embedded print-hook-script post-checkout",
		"$ git-embedded print-hook-script reference-transaction",
		"$ git-embedded print-hook-script _dispatch"
	]
};

export function run(name) {
	const sourceName = NAME_TO_SOURCE[name];
	if (!sourceName) {
		self.report.error(`Unknown hook script: ${name}`);
		self.report.error(`Known names: ${Object.keys(NAME_TO_SOURCE).sort().join(", ")}`);
		process.exit(2);
	}
	const source = context.path.join(self.paths.hooksSourceDir(), sourceName);
	process.stdout.write(context.fs.readFileSync(source, "utf8"));
}

export default { spec, run };
