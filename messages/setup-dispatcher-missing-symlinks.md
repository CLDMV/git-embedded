## Dispatcher pattern detected — missing required hook entries

This machine has a dispatcher script at the path printed above, but the dispatcher directory is missing one or more entries (symlink, hard link, or copy) needed for `git-embedded` to function.

The required hook events are:

- `post-checkout`
- `post-merge`
- `post-rewrite`
- `reference-transaction`

Any missing entry means git skips that hook event entirely — even if the per-repo `.git/hooks/<name>` exists, git never reaches it because the dispatcher directory has nothing to invoke.

## What the CLI proposes

Heal the dispatcher by creating the missing entries — symlinks by default, or hard links if you pass `--no-symlinks`. On Windows without elevation, creating symlinks requires UAC; the CLI requests elevation and creates all missing entries in one batch when you accept. Declining the UAC prompt exits the CLI without changes; use `--no-symlinks` if you want the no-prompt hard-link path instead.

The dispatcher script itself is not modified — only missing entries are added.

This is a global change to `core.hooksPath`'s directory. It will affect all repos that use this dispatcher, but only by enabling hook events that were previously disabled. Existing entries are not touched.

## After healing

The CLI will then install `git-embedded`'s hook scripts into this repo's `.git/hooks/`, and the now-complete dispatcher will activate them.

## Decline

If you decline the heal, the CLI exits without changes. You can heal manually:

**Linux / macOS (symlinks, no elevation needed):**

```bash
ln -sf _dispatch <dispatcher-dir>/post-checkout
ln -sf _dispatch <dispatcher-dir>/post-merge
ln -sf _dispatch <dispatcher-dir>/post-rewrite
ln -sf _dispatch <dispatcher-dir>/reference-transaction
```

**Windows (symlinks, run from an elevated Command Prompt):**

```cmd
mklink "<dispatcher-dir>\post-checkout" "<dispatcher-dir>\_dispatch"
mklink "<dispatcher-dir>\post-merge" "<dispatcher-dir>\_dispatch"
mklink "<dispatcher-dir>\post-rewrite" "<dispatcher-dir>\_dispatch"
mklink "<dispatcher-dir>\reference-transaction" "<dispatcher-dir>\_dispatch"
```

**Windows (hard links, no elevation needed — alternative if you don't want to elevate):**

```cmd
mklink /H "<dispatcher-dir>\post-checkout" "<dispatcher-dir>\_dispatch"
mklink /H "<dispatcher-dir>\post-merge" "<dispatcher-dir>\_dispatch"
mklink /H "<dispatcher-dir>\post-rewrite" "<dispatcher-dir>\_dispatch"
mklink /H "<dispatcher-dir>\reference-transaction" "<dispatcher-dir>\_dispatch"
```

(Hard links work on NTFS without elevated permissions. If your dispatcher dir is on a non-NTFS volume, copy `_dispatch` to each missing name instead.)

Re-run `git embedded install-hooks` after healing.
