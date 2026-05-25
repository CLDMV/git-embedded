import slothlet from "@cldmv/slothlet";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import chalk from "chalk";
import { Command, Help } from "commander";
import { wisp, wispSync } from "@cldmv/wisp";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

marked.use(markedTerminal({ showSectionPrefix: false }));
const renderMarkdown = (md) => marked.parse(md).replace(/^(\s*)\* /gm, "$1- ");

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const apiDir = path.join(packageRoot, "src", "api");

let apiPromise = null;

/**
 * Build the slothlet api the same way bin/git-embedded.mjs does. Cached so
 * each test file only loads once.
 */
export function getApi() {
	if (!apiPromise) {
		apiPromise = slothlet({
			dir: apiDir,
			context: {
				fs,
				path,
				os,
				chalk,
				readline,
				spawn,
				spawnSync,
				fileURLToPath,
				pathToFileURL,
				commander: { Command, Help },
				wisp,
				wispSync,
				renderMarkdown,
				packageRoot
			}
		});
	}
	return apiPromise;
}
