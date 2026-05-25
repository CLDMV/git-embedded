import { self, context } from "@cldmv/slothlet/runtime";

const ERROR_CANCELLED = 1223;

/**
 * Re-launch the current Node binary as Administrator via PowerShell's
 * `Start-Process -Verb RunAs` and have it create a batch of symlinks. Each
 * entry is `{ source, target }` — `source` is the link to create, `target` is
 * what it points at.
 *
 * Cancellation of the UAC prompt is detected via the spawned process's exit
 * code (ERROR_CANCELLED = 1223). All other non-zero exits are surfaced as
 * failures.
 *
 * @param {Array<{source:string,target:string}>} plan
 */
export default function elevateWindows(plan) {
	if (process.platform !== "win32") {
		throw new Error("link.elevateWindows is Windows-only");
	}
	if (!Array.isArray(plan) || plan.length === 0) {
		return { ok: true, cancelled: false, exitCode: 0 };
	}

	const { fs, path, os, spawnSync } = context;
	const tmpPath = path.join(os.tmpdir(), `git-embedded-symlink-batch-${process.pid}-${Date.now()}.json`);
	fs.writeFileSync(tmpPath, JSON.stringify(plan, null, 2));

	const childScript = path.join(self.paths.packageRoot(), "src", "lib", "elevate-windows-child.mjs");
	const node = process.execPath;

	const argList = [childScript, tmpPath].map((s) => `'${s.replace(/'/g, "''")}'`).join(",");
	const psCommand = `try { $p = Start-Process -FilePath '${node.replace(/'/g, "''")}' -ArgumentList @(${argList}) -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { if ($_.Exception.NativeErrorCode -eq ${ERROR_CANCELLED} -or $_.Exception.HResult -eq -2147467260) { exit ${ERROR_CANCELLED} } else { Write-Error $_; exit 1 } }`;

	const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psCommand], {
		stdio: ["ignore", "pipe", "pipe"]
	});

	try {
		fs.unlinkSync(tmpPath);
	} catch {
		// ignore cleanup failure
	}

	const exitCode = result.status ?? 1;
	if (exitCode === 0) return { ok: true, cancelled: false, exitCode };
	if (exitCode === ERROR_CANCELLED) {
		return { ok: false, cancelled: true, exitCode, message: "UAC elevation cancelled by user" };
	}
	const stderr = (result.stderr || Buffer.alloc(0)).toString("utf8").trim();
	return { ok: false, cancelled: false, exitCode, message: stderr || `elevated symlink batch exited ${exitCode}` };
}
