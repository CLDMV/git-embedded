import { self, context } from "@cldmv/slothlet/runtime";

/**
 * Append-only JSONL transaction log. Each install/uninstall operation appends
 * one line; uninstall replays the log to know what to remove.
 *
 * @namespace api.log
 */

export function append(entry) {
	const { fs, path } = context;
	const log = self.paths.transactionLogPath();
	fs.mkdirSync(path.dirname(log), { recursive: true });
	const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
	fs.appendFileSync(log, line);
}

export function read() {
	const { fs } = context;
	const log = self.paths.transactionLogPath();
	if (!fs.existsSync(log)) return [];
	return fs
		.readFileSync(log, "utf8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
}

export function path() {
	return self.paths.transactionLogPath();
}
