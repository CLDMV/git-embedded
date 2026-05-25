## System-scope `core.hooksPath` detected

`git config --system core.hooksPath` is set on this machine to the path printed above. This is unusual — typically set by a system administrator, corporate management tool, or a Linux distribution's git packaging.

The contents of the system hooks path determine how this configuration affects `git-embedded`:

- If the system path contains a **dispatcher** that chains to `.git/hooks/`, behavior is the same as a global canonical dispatcher (setup #2). `git-embedded` can install per-repo hooks normally; the system dispatcher chains to them.
- If the system path contains **bare hook scripts** without a chain mechanism, anything `git-embedded` installs in `.git/hooks/` will never fire. Integration requires either modifying the system dispatcher (needs sudo / admin) or overriding `core.hooksPath` at a narrower scope (global or local).

## What the CLI proposes

- Print the classification of the system hooks path so you can see what's there.
- For dispatcher-style system setups: install per-repo hooks as normal. No system change needed.
- For non-dispatcher system setups: refuse to install and suggest one of:
  - Override `core.hooksPath` at your user-global scope (`git config --global core.hooksPath …`) pointing at a personal dispatcher you control.
  - Override `core.hooksPath` at the repo-local scope for just this repo.
  - Escalate to your system administrator to convert the system dispatcher to a chaining model.

## Why the CLI will not modify system config

System-scope git config requires elevated privileges to change. Modifying it without explicit `--system --yes` flags risks breaking other users' workflows on shared machines. Even with such flags, blind modification of system config is the wrong default. The CLI will only ever advise.

## Permission considerations

If you do not have sudo or admin on this machine, the only available remediations are user-global or local overrides. Both work — the user-global override takes precedence for all your repos; the local override applies to just one repo. Pick based on whether you want this behavior in every repo you work in or just this one.
