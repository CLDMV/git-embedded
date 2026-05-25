import { self, context } from "@cldmv/slothlet/runtime";

export const spec = {
	command: "version",
	aliases: ["-V", "--version"],
	description: "Print git-embedded, node, and platform versions.",
	examples: ["$ git-embedded version"]
};

export function run() {
	const pkg = context.wispSync(context.path.join(self.paths.packageRoot(), "package.json"));
	console.log(`${pkg.name} ${pkg.version}`);
	console.log(`node ${process.version.replace(/^v/, "")}`);
	console.log(`platform ${process.platform}`);
}

export default { spec, run };
