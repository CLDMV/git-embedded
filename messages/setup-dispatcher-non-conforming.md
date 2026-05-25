## Non-conforming dispatcher detected

This machine has `core.hooksPath` pointed at a directory that contains a dispatcher-style script (multiple hook names redirect to one common script), but that dispatcher does NOT chain to per-repo hooks.

That means anything `git-embedded` places in `.git/hooks/<name>` is never reached. The dispatcher swallows each hook event without falling through to per-repo customization.

## Why the CLI will not modify the dispatcher

Even with consent, rewriting someone else's dispatcher script is too invasive. The dispatcher enforces policies that may be load-bearing for other tools, security workflows, or team agreements. Modifying it risks breaking those.

## Integration options

**Option 1: modify the dispatcher to chain to per-repo hooks.**

Add a block at the end of the dispatcher script that exec's the per-repo hook:

```sh
# --- chain to the repository's own hook, if any ---
git_dir=$(git rev-parse --absolute-git-dir 2>/dev/null) || exit 0
repo_hook="$git_dir/hooks/$(basename "$0")"
if [ -x "$repo_hook" ] && [ "$repo_hook" != "$0" ]; then
    exec "$repo_hook" "$@"
fi
exit 0
```

Once added, re-run `git embedded install-hooks`. The dispatcher becomes conforming and the install proceeds normally.

**Option 2: switch to the canonical dispatcher pattern.**

If your dispatcher's policies are simple enough to port, the canonical dispatcher pattern (a small `_dispatch` script at `~/.config/git/hooks/` plus one symlink per standard hook name, chaining to per-repo hooks at the end) is a drop-in replacement. `git embedded install-hooks` after the switch will detect the new dispatcher and install cleanly.

**Option 3: bring-your-own mode.**

Run `git embedded print-hook-script <name>` for each hook event you want to enable. Paste the contents into the body of your dispatcher at the appropriate spot, gated by `basename "$0"` matching the hook name. Your dispatcher then runs the `git-embedded` logic inline instead of via chaining.
