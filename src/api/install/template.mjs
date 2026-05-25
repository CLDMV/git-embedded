import { self, context } from "@cldmv/slothlet/runtime";

/**
 * Install the package's hook scripts into a `git init.templateDir/hooks`
 * directory so new repos start with them.
 *
 * @param {string} templateDir
 * @param {object} [opts]
 * @param {boolean} [opts.force]
 */
export default function template(templateDir, opts = {}) {
	const { fs, path } = context;
	fs.mkdirSync(path.join(templateDir, "hooks"), { recursive: true });
	return self.install.hooks("install", templateDir, opts);
}
