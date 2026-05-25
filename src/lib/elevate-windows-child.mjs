#!/usr/bin/env node
//
// Elevated child process: reads a JSON file with an array of
// { source, target } entries and creates symbolic links for each.
// Spawned by elevate-windows.mjs via PowerShell's `Start-Process -Verb RunAs`.

import fs from "node:fs";

const planPath = process.argv[2];
if (!planPath) {
	console.error("elevate-windows-child: missing plan file argument");
	process.exit(2);
}

let plan;
try {
	plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
} catch (err) {
	console.error("elevate-windows-child: failed to read plan:", err.message);
	process.exit(3);
}

let failures = 0;
for (const entry of plan) {
	if (!entry || !entry.source || !entry.target) {
		failures++;
		continue;
	}
	try {
		// Remove any existing entry so the link can be (re-)created cleanly.
		try {
			fs.unlinkSync(entry.source);
		} catch {
			// ignore — most likely doesn't exist yet
		}
		fs.symlinkSync(entry.target, entry.source, "file");
	} catch (err) {
		failures++;
		console.error(`failed to symlink ${entry.source} -> ${entry.target}: ${err.message}`);
	}
}

process.exit(failures === 0 ? 0 : 4);
