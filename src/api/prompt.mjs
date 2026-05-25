import { context } from "@cldmv/slothlet/runtime";

/**
 * Minimal interactive prompts. Honors `--yes` via `opts.yes` and
 * non-TTY input by returning the default.
 *
 * @namespace api.prompt
 */

export function confirm(question, opts = {}) {
	const { defaultYes = false, yes = false } = opts;
	if (yes) return Promise.resolve(true);
	if (!process.stdin.isTTY) return Promise.resolve(defaultYes);

	const suffix = defaultYes ? "[Y/n]" : "[y/N]";
	const rl = context.readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question(`${question} ${suffix} `, (answer) => {
			rl.close();
			const trimmed = (answer || "").trim().toLowerCase();
			if (trimmed === "") resolve(defaultYes);
			else if (trimmed === "y" || trimmed === "yes") resolve(true);
			else resolve(false);
		});
	});
}
