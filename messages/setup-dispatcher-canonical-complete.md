## Dispatcher pattern detected — ready to install

This machine has the canonical dispatcher pattern installed at the path printed above. The dispatcher chains to per-repo hooks at `.git/hooks/<name>` after running any global policy, and all required hook symlinks are present.

## What the CLI will do

- Install `git-embedded`'s hook scripts into this repo's `.git/hooks/` directory:
  - `post-checkout` — updates embedded children after checkout-style operations
  - `post-merge` — updates embedded children after merges
  - `post-rewrite` — updates embedded children after rebases
  - `reference-transaction` — refuses HEAD-moving operations when any embedded child is dirty
- Set the executable bit on each script.
- Log the install to the transaction file so it can be reversed with `git embedded uninstall-hooks`.

No global state is modified. The dispatcher you already have activates the new scripts automatically.

## After install

Test the setup:

```bash
# Should report all four hooks installed and active
git embedded doctor
```

To remove later:

```bash
git embedded uninstall-hooks
```
