## `init.templateDir` detected

`git config --global init.templateDir` is set on this machine to the path printed above. That directory's contents are copied into `.git/` of every newly-created or freshly-cloned repository, including any hook scripts in `<template>/hooks/`.

This is complementary to per-repo hook installation, not a conflict. New repos start with whatever's in the template; existing repos are unaffected.

## What the CLI offers

In addition to installing hooks into this repo's `.git/hooks/` normally, the CLI can copy `git-embedded`'s hook scripts into `<template>/hooks/` so that **future** new and cloned repos start with the hooks already in place. This is opt-in and requires confirmation because it modifies global state.

If you accept, the four hook scripts (`post-checkout`, `post-merge`, `post-rewrite`, `reference-transaction`) are written into the template's `hooks/` directory. The next `git init` or `git clone` on this machine copies them into the new repo automatically.

## Caveats

- **Templates are copied, not symlinked.** Updates to the scripts in the template do not propagate to existing repos. To update, re-run `git embedded install-template` after updating the package; old repos retain whatever was in their template at clone time.
- **Doesn't fix existing repos.** Only future ones benefit. Run `git embedded install-hooks` per-repo for repos that already exist.
- **Per-repo install is still recommended** even with template install set up. The template install only matters at `git init` / `git clone` time. If you `git init` and forget the package was supposed to be installed, you still get the hooks. But if you clone an existing repo, the template still applies — which may or may not be what you want for repos that don't actually use `git-embedded`.

## Decline

If you decline, nothing changes globally. The CLI proceeds with per-repo install only, which is the safer default.
