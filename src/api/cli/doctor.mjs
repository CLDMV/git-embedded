import { self } from "@cldmv/slothlet/runtime";

export const spec = {
	command: "doctor",
	description: "Inspect the current environment and report what would happen on install. Takes no action.",
	examples: ["$ git-embedded doctor"]
};

export async function run() {
	const result = await self.detect.run(process.cwd());
	self.report.detectionHeader(result);
	self.report.message(result.kind);
}

export default { spec, run };
