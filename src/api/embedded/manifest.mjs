import { context } from "@cldmv/slothlet/runtime";

/**
 * The manifest is a TRANSFER FORMAT only — a JSON document that carries child
 * URLs between machines by hand. It is never committed to any repo (that would
 * defeat the whole point of anonymous gitlinks); it lives outside the tree, in
 * the user's own hands. Shape:
 *
 *   { "version": 1, "children": { "<path>": { "url": "…", "branch": "…" } } }
 *
 * @namespace api.embedded.manifest
 */

/**
 * Read and parse a manifest file.
 * @param {string} file manifest path (absolute, or relative to `cwd`)
 * @param {string} [cwd] base directory for a relative `file`
 * @returns {{ version: number, children: object }|null} parsed manifest, or
 *   null when the file does not exist
 * @throws {Error} when the file exists but is not valid manifest JSON
 */
export function read(file, cwd = process.cwd()) {
	const { fs, path } = context;
	const abs = path.isAbsolute(file) ? file : path.resolve(cwd, file);
	if (!fs.existsSync(abs)) return null;
	let obj;
	try {
		obj = JSON.parse(fs.readFileSync(abs, "utf8"));
	} catch (err) {
		throw new Error(`manifest ${abs} is not valid JSON: ${err.message}`);
	}
	if (!obj || typeof obj !== "object" || typeof obj.children !== "object" || obj.children === null || Array.isArray(obj.children)) {
		throw new Error(`manifest ${abs} is missing a "children" object (a path → { url, branch } map, not an array)`);
	}
	// Gate the format version so an incompatible manifest fails loudly at read
	// time instead of producing hard-to-diagnose behavior downstream.
	if (obj.version !== 1) {
		throw new Error(`manifest ${abs} has unsupported version ${JSON.stringify(obj.version)} (expected 1)`);
	}
	return obj;
}

/**
 * Build a manifest object from registry entries.
 * @param {Array<{ path: string, url?: string, branch?: string }>} entries
 * @returns {{ version: number, children: object }} manifest object; entries
 *   without a URL are dropped (a manifest without a URL is useless)
 */
export function build(entries) {
	// Null-prototype map: a child path named __proto__ must become a plain own
	// key, never a prototype mutation.
	const children = Object.create(null);
	for (const e of entries || []) {
		if (!e || !e.url) continue;
		children[e.path] = { url: e.url };
		if (e.branch) children[e.path].branch = e.branch;
	}
	return { version: 1, children };
}

/**
 * Serialize a manifest object to its on-disk JSON text (tab-indented, trailing
 * newline).
 * @param {object} manifestObj manifest object from {@link build}
 * @returns {string}
 */
export function serialize(manifestObj) {
	return JSON.stringify(manifestObj, null, "\t") + "\n";
}

export default { read, build, serialize };
