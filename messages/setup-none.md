## No hook setup detected

This machine has no `core.hooksPath` set at any scope (system, global, or local), and the repo's `.git/hooks/` directory holds only git's default `.sample` files.

That means git is using its out-of-the-box per-repo hooks model — hooks placed in `.git/hooks/` will run, but they don't travel with a clone, and there's no shared infrastructure for global policy (commit-message validation, push-time checks, etc.).

## Recommended: install the dispatcher pattern globally

The dispatcher pattern is a one-time setup that benefits every repo on this machine. It:

- Adds a small dispatcher script to `~/.config/git/hooks/` (or a path of your choice).
- Creates a symlink for each standard hook name pointing at the dispatcher. On Linux and macOS this requires no special permissions. On Windows it requires admin elevation — the CLI requests UAC and creates all symlinks in one batch on accept. If you prefer to avoid the elevation prompt, pass `--no-symlinks` to use hard links instead (works on NTFS without elevation).
- Sets `git config --global core.hooksPath` to that directory.
- The dispatcher chains to each repo's `.git/hooks/<name>` after running any global policy, so per-repo hooks keep working everywhere.

Once installed, `git-embedded` can install its scripts into the current repo's `.git/hooks/` and the global dispatcher activates them automatically. Future repos work the same way with no per-repo setup beyond running `git embedded install-hooks` once.

## Alternative: install scripts into this repo only

If you don't want a global change, the CLI will install hooks directly into the current repo's `.git/hooks/`. Limitations:

- Hooks don't travel with the repo (`.git/` is not tracked). Other developers cloning this repo need to install separately.
- No global policy hooks are available (commit-msg, pre-push). Only what `git-embedded` provides will fire.

## Bring-your-own mode

If you have a different setup in mind, run `git embedded print-hook-script <hook-name>` to see the script content and wire it in however you like.
