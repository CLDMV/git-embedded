/**
 *
 *	@Project: @cldmv/git-embedded
 *	@Filename: /src/api/paths.mjs
 *	@Date: 2026-05-24T21:13:00-07:00 (1779682380)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:24-07:00 (1790968824)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { context } from "@cldmv/slothlet/runtime";

/**
 * Path constants and platform-aware path computations. All values are derived
 * from the host's `context.packageRoot` (set by bin/git-embedded.mjs) and the
 * standard XDG environment variables.
 *
 * @namespace api.paths
 */

export function packageRoot() {
	return context.packageRoot;
}

export function hooksSourceDir() {
	return context.path.join(context.packageRoot, "hooks");
}

export function messagesDir() {
	return context.path.join(context.packageRoot, "messages");
}

export function stateDir() {
	const { path, os } = context;
	if (process.platform === "win32") {
		const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
		return path.join(base, "git-embedded");
	}
	const xdg = process.env.XDG_STATE_HOME;
	const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".local", "state");
	return path.join(base, "git-embedded");
}

export function transactionLogPath() {
	return context.path.join(stateDir(), "install.log");
}

export function defaultGlobalDispatcherDir() {
	const { path, os } = context;
	const xdg = process.env.XDG_CONFIG_HOME;
	const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
	return path.join(base, "git", "hooks");
}
