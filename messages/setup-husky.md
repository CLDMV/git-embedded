## Husky detected

This repo uses [Husky](https://github.com/typicode/husky) for git hook management. Signals: `.husky/` directory at repo root, `"prepare": "husky"` script in `package.json`, and local `core.hooksPath` set to `.husky`.

Husky writes hook scripts directly into `.husky/<name>`. Those scripts shadow anything in `.git/hooks/`, so `git-embedded` cannot install via the normal per-repo path.

## Why the CLI will not auto-integrate

Husky re-runs its setup on every `npm install` via the `prepare` lifecycle script. Files we write into `.husky/` could be overwritten or moved by Husky's reinstall, depending on Husky version and project configuration. Auto-edits to `.husky/<name>` files also lack a reliable rollback path if Husky's behavior changes between versions.

## Manual integration options

**Option 1: append our invocation to Husky's hook files.**

Each `.husky/<name>` file is a plain shell script. Append a call to our hook script at the end (after Husky's own setup line, if present):

```sh
# .husky/post-checkout
. "$(dirname -- "$0")/_/husky.sh"   # Husky v8 only; omit on v9+

# ... any existing Husky-managed commands ...

# --- git-embedded: update embedded repos ---
npx git-embedded run-hook post-checkout "$@"
```

Repeat for `post-merge`, `post-rewrite`, and `reference-transaction`. Husky's setup typically does not regenerate the body of hook files once they exist, so your additions persist — but verify on your specific Husky version.

**Option 2: replace Husky with the dispatcher pattern.**

The canonical dispatcher pattern (a small `_dispatch` script installed at `~/.config/git/hooks/`) covers the same ground as Husky — managed hooks plus per-repo extension — without the npm `prepare`-script execution path, which is a smaller supply-chain surface. Replacing Husky removes the `.husky/` directory, unsets local `core.hooksPath`, installs the dispatcher globally, and reruns `git embedded install-hooks`.

**Option 3: bring-your-own mode.**

Run `git embedded print-hook-script <name>` to get the script content, paste it inline into the relevant `.husky/<name>` file. Same as Option 1 but with the body inlined rather than invoked via `npx`.
