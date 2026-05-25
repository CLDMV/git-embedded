import { context } from "@cldmv/slothlet/runtime";

/**
 * Copy a file to a destination, preserving the +x bit on Unix.
 *
 * @param {string} source
 * @param {string} dest
 * @param {object} [opts]
 * @param {boolean} [opts.overwrite=true]
 */
export default function copyExecutable(source, dest, { overwrite = true } = {}) {
	const { fs, path } = context;
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	if (overwrite) {
		try {
			fs.lstatSync(dest);
			fs.unlinkSync(dest);
		} catch {
			// nothing to remove
		}
	}
	fs.copyFileSync(source, dest);
	if (process.platform !== "win32") {
		const st = fs.statSync(dest);
		fs.chmodSync(dest, st.mode | 0o111);
	}
}
