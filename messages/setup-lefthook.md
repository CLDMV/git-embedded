## Lefthook detected

This repo uses [Lefthook](https://github.com/evilmartians/lefthook) for git hook management. Signals: `lefthook.yml` (or `.lefthook.yml`, `lefthook.yaml`, `.lefthook.yaml`) at repo root, hook files in `.git/hooks/` with a Lefthook-generated header.

Lefthook writes hook files into `.git/hooks/` from its YAML config and may overwrite them on the next `lefthook install`. `git-embedded` cannot install into `.git/hooks/` without risk of being overwritten.

## Why the CLI will not auto-integrate

Lefthook is the source of truth for `.git/hooks/` content in projects that use it. Editing those files directly is undone the next time Lefthook regenerates. Modifying `lefthook.yml` is the correct integration path, but parsing and editing arbitrary user YAML reliably (preserving comments, formatting, ordering) is too easy to get wrong for an automated tool to do silently.

## Manual integration

Edit `lefthook.yml` to add `git-embedded`'s scripts as commands under each relevant hook event:

```yaml
# lefthook.yml

post-checkout:
  commands:
    git-embedded:
      run: npx git-embedded run-hook post-checkout {1} {2} {3}

post-merge:
  commands:
    git-embedded:
      run: npx git-embedded run-hook post-merge {1}

post-rewrite:
  commands:
    git-embedded:
      run: npx git-embedded run-hook post-rewrite {1}

reference-transaction:
  commands:
    git-embedded:
      run: npx git-embedded run-hook reference-transaction {1}
      # NOTE: lefthook's support for reference-transaction may vary by version.
      # If your lefthook version doesn't list reference-transaction as a
      # supported event, install that one hook outside of lefthook (directly
      # into .git/hooks/reference-transaction) and lefthook will leave it
      # alone.
```

Then run `lefthook install` to regenerate `.git/hooks/` from the updated config. Run `git embedded doctor` to confirm the hooks are wired correctly.

## Bring-your-own mode

`git embedded print-hook-script <name>` outputs the script body. You can inline it inside a lefthook `run:` block, or put it in a script file in the repo and reference that file from `lefthook.yml`.
