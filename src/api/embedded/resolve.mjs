import { self } from "@cldmv/slothlet/runtime";

/**
 * Last path segment of a gitlink path (its "basename"), slash-normalized so
 * `vendor/foo` → `foo` and a trailing slash is ignored.
 * @param {string} childPath
 * @returns {string}
 */
function basename(childPath) {
	const parts = String(childPath).split("/").filter(Boolean);
	return parts.length ? parts[parts.length - 1] : String(childPath);
}

/**
 * Convention URL: the child is a sibling of wherever the parent was cloned
 * from. Takes the parent's origin URL, drops its final path segment (the
 * parent's own repo name), and appends `<basename>.git`.
 *
 * Handles both scp-style (`git@host:org/parent.git`) and URL-style
 * (`https://host/org/parent.git`, `/srv/remotes/parent.git`) origins: the split
 * is on the last `/` when one exists; a scp-style origin whose repo sits at the
 * path root (`git@host:parent.git`) has no `/`, so the sibling lives after the
 * last `:` instead.
 *
 * @param {string|null} parentOrigin the parent's `remote.origin.url`
 * @param {string} childPath gitlink path
 * @returns {string|null} the derived URL, or null when no origin is available
 */
export function conventionUrl(parentOrigin, childPath) {
	if (!parentOrigin) return null;
	const trimmed = parentOrigin.replace(/\/+$/, "");
	const idx = trimmed.lastIndexOf("/");
	if (idx >= 0) return `${trimmed.slice(0, idx)}/${basename(childPath)}.git`;
	const colon = trimmed.lastIndexOf(":");
	if (colon < 0) return null;
	return `${trimmed.slice(0, colon)}:${basename(childPath)}.git`;
}

/**
 * Resolve a child's clone URL, strictest source first. This is the security
 * model's heart: URL knowledge is never committed, so a URL can only come from
 * one of three OPTIONAL layers, tried in order —
 *
 *   1. `local-config` — the per-clone registry (`embedded.<path>.url`).
 *   2. `manifest`      — a hand-carried transfer file passed via `--from`.
 *   3. `base`          — an explicit `--base <url-base>` + `<basename>.git`.
 *   4. `convention`    — sibling of the parent's origin (zero committed state).
 *
 * A `base`/`convention` result is only a *guess*; the caller SHA-verifies every
 * clone so a wrong guess fails closed rather than planting the wrong repo.
 *
 * @param {string} childPath gitlink path to resolve
 * @param {object} [opts]
 * @param {string} [opts.cwd] parent repo working directory (for layer 1)
 * @param {object|null} [opts.manifest] parsed manifest `{ children: {…} }` (layer 2)
 * @param {string|null} [opts.base] explicit URL base (layer 3)
 * @param {string|null} [opts.parentOrigin] parent `remote.origin.url` (layer 4)
 * @returns {{ url: string, source: "local-config"|"manifest"|"base"|"convention" }
 *   | { url: null, source: null }}
 */
export default function resolve(childPath, opts = {}) {
	const { cwd = process.cwd(), manifest = null, base = null, parentOrigin = null } = opts;

	// 1. Local-config registry — strictest, per-clone, never committed.
	const cfgUrl = self.embedded.registry.getUrl(childPath, cwd);
	if (cfgUrl) return { url: cfgUrl, source: "local-config" };

	// 2. Manifest file (transfer format, carried out-of-band via --from).
	const child = manifest && manifest.children ? manifest.children[childPath] : null;
	if (child && child.url) return { url: child.url, source: "manifest" };

	// 3. Explicit --base + basename.
	if (base) {
		const dir = String(base).replace(/\/+$/, "");
		return { url: `${dir}/${basename(childPath)}.git`, source: "base" };
	}

	// 4. Convention: sibling of the parent's origin. Zero committed state; a
	//    wrong guess is caught by SHA verification downstream.
	const conv = conventionUrl(parentOrigin, childPath);
	if (conv) return { url: conv, source: "convention" };

	return { url: null, source: null };
}
