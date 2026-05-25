## Bare `.githooks/` directory detected

This repo has `core.hooksPath` set to an in-repo path (typically `.githooks/`) containing hook scripts directly — no dispatcher script, no symlinks. The directory is tracked, so the hooks travel with the repo. This is the "hand-rolled, minimum dependency" setup.

`git-embedded` could install its scripts into this directory, but doing so means the scripts become tracked files in your repo. That is a deliberate choice the maintainer should make, not something the CLI should do silently.

## Why the CLI will not auto-install

Tracked files alter the repo's content and history. The decision to commit `git-embedded`'s scripts into the repo (vs keeping them as an install-time artifact via the npm dependency) is a project-level call about how the hooks are sourced. The CLI defers this.

## Integration options

**Option 1: commit the scripts into the tracked `.githooks/` directory.**

Run `git embedded copy-hooks-to .githooks/` (or whatever path your `core.hooksPath` points at). The CLI copies the four hook scripts into that directory. You then `git add .githooks/ && git commit`. From that point, the scripts ship with the repo — `npm install` is not required to get them.

Tradeoff: a copy of the scripts lives in your repo's history, separately from the npm-tracked version. Updates require re-running `copy-hooks-to` and committing.

**Option 2: convert to the dispatcher pattern.**

If you want a cleaner separation between "infrastructure that ships with the repo" and "policies the dispatcher enforces," the canonical dispatcher pattern gives you that: a small `_dispatch` script installed at `~/.config/git/hooks/` runs global policy and chains to whatever per-repo hooks each project ships. The bare `.githooks/` becomes a `.d/`-style directory underneath. `git embedded install-hooks` after the switch will detect the new dispatcher and install cleanly without committing files to the repo.

**Option 3: bring-your-own mode.**

`git embedded print-hook-script <name>` outputs each script's content. Paste them into your `.githooks/` files yourself, however you'd like to combine them with any existing hooks there.
