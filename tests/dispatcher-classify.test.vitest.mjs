import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getApi } from "./_setup.mjs";

const tmpRoots = [];

function mkTmp() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-embedded-test-"));
	tmpRoots.push(dir);
	return dir;
}

afterEach(() => {
	while (tmpRoots.length) {
		const d = tmpRoots.pop();
		try {
			fs.rmSync(d, { recursive: true, force: true });
		} catch {
			// ignore
		}
	}
});

const CHAINING_DISPATCHER = `#!/bin/sh
# git-embedded-compatible dispatcher
hook=$(basename "$0")
git_dir=$(git rev-parse --absolute-git-dir 2>/dev/null) || exit 0
repo_hook="$git_dir/hooks/$hook"
if [ -x "$repo_hook" ] && [ "$repo_hook" != "$0" ]; then
    exec "$repo_hook" "$@"
fi
exit 0
`;

const NONCHAINING_DISPATCHER = `#!/bin/sh
hook=$(basename "$0")
case "$hook" in
commit-msg) echo "policy"; ;;
esac
exit 0
`;

function writeDispatcher(dir, body) {
	const p = path.join(dir, "_dispatch");
	fs.writeFileSync(p, body);
	fs.chmodSync(p, 0o755);
	return p;
}

const REQUIRED_HOOKS = ["post-checkout", "post-merge", "post-rewrite", "reference-transaction"];
const STANDARD_HOOK_NAMES = [
	"applypatch-msg",
	"commit-msg",
	"post-applypatch",
	"post-checkout",
	"post-commit",
	"post-merge",
	"post-rewrite",
	"pre-applypatch",
	"pre-auto-gc",
	"pre-commit",
	"pre-merge-commit",
	"pre-push",
	"pre-rebase",
	"prepare-commit-msg",
	"reference-transaction"
];

let api;
beforeAll(async () => {
	api = await getApi();
});

describe("api.detect.dispatcher (hooks-dir classifier)", () => {
	it("returns empty for an empty directory", () => {
		const dir = mkTmp();
		expect(api.detect.dispatcher(dir).kind).toBe("empty");
	});

	it("classifies a canonical complete dispatcher", () => {
		const dir = mkTmp();
		const dispatch = writeDispatcher(dir, CHAINING_DISPATCHER);
		for (const name of STANDARD_HOOK_NAMES) {
			fs.symlinkSync(dispatch, path.join(dir, name));
		}
		const out = api.detect.dispatcher(dir);
		expect(out.kind).toBe("dispatcher-canonical-complete");
		expect(out.dispatcherPath).toBe(dispatch);
		for (const hook of REQUIRED_HOOKS) {
			expect(Array.from(out.present)).toContain(hook);
		}
	});

	it("classifies a dispatcher with missing required entries", () => {
		const dir = mkTmp();
		const dispatch = writeDispatcher(dir, CHAINING_DISPATCHER);
		fs.symlinkSync(dispatch, path.join(dir, "post-checkout"));
		fs.symlinkSync(dispatch, path.join(dir, "post-merge"));
		fs.symlinkSync(dispatch, path.join(dir, "pre-commit"));
		const out = api.detect.dispatcher(dir);
		expect(out.kind).toBe("dispatcher-missing-symlinks");
		const missing = Array.from(out.missing);
		expect(missing).toContain("post-rewrite");
		expect(missing).toContain("reference-transaction");
		const present = Array.from(out.present);
		expect(present).toContain("post-checkout");
		expect(present).toContain("post-merge");
	});

	it("classifies a non-conforming dispatcher (no chain to per-repo hook)", () => {
		const dir = mkTmp();
		const dispatch = writeDispatcher(dir, NONCHAINING_DISPATCHER);
		for (const name of REQUIRED_HOOKS) {
			fs.symlinkSync(dispatch, path.join(dir, name));
		}
		const out = api.detect.dispatcher(dir);
		expect(out.kind).toBe("dispatcher-non-conforming");
		expect(out.dispatcherPath).toBe(dispatch);
	});

	it("classifies a bare hooks directory with no dispatcher", () => {
		const dir = mkTmp();
		fs.writeFileSync(path.join(dir, "pre-commit"), "#!/bin/sh\necho hi\n");
		fs.chmodSync(path.join(dir, "pre-commit"), 0o755);
		const out = api.detect.dispatcher(dir);
		expect(out.kind).toBe("bare-githooks");
	});

	it("recognizes a hardlink-style dispatcher with no _dispatch file", () => {
		const dir = mkTmp();
		const real = path.join(dir, "pre-commit");
		fs.writeFileSync(real, CHAINING_DISPATCHER);
		fs.chmodSync(real, 0o755);
		fs.linkSync(real, path.join(dir, "post-checkout"));
		fs.linkSync(real, path.join(dir, "post-merge"));
		fs.linkSync(real, path.join(dir, "post-rewrite"));
		fs.linkSync(real, path.join(dir, "reference-transaction"));
		const out = api.detect.dispatcher(dir);
		expect(out.kind).toBe("dispatcher-canonical-complete");
	});
});
