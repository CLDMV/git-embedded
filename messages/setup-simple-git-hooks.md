## simple-git-hooks detected

This repo uses [simple-git-hooks](https://github.com/toplenboren/simple-git-hooks) for git hook management. Signal: `"simple-git-hooks"` key in `package.json`.

simple-git-hooks writes hook scripts directly into `.git/hooks/` from the `package.json` config. Running `npx simple-git-hooks` regenerates those files from the config. `git-embedded` cannot install into `.git/hooks/` without risk of being overwritten on the next regeneration.

## Why the CLI will not auto-integrate

`package.json` is the source of truth for simple-git-hooks. Editing `.git/hooks/<name>` directly is undone the next time the user runs `npx simple-git-hooks`. Modifying `package.json` is the correct integration path, but unattended JSON edits to a shared file (where developers may have local changes) is risky enough to avoid automating.

## Manual integration

Edit `package.json` to add `git-embedded`'s invocations to the `simple-git-hooks` block. Each entry is a shell command; chain ours with `&&` after any existing command:

```json
{
	"simple-git-hooks": {
		"post-checkout": "npx git-embedded run-hook post-checkout \"$@\"",
		"post-merge": "npx git-embedded run-hook post-merge \"$@\"",
		"post-rewrite": "npx git-embedded run-hook post-rewrite \"$@\"",
		"reference-transaction": "npx git-embedded run-hook reference-transaction \"$@\""
	}
}
```

If you have existing entries for these hooks, chain them:

```json
"post-checkout": "your-existing-command && npx git-embedded run-hook post-checkout \"$@\""
```

After editing, run `npx simple-git-hooks` to regenerate `.git/hooks/`. Run `git embedded doctor` to confirm.

## Caveat about reference-transaction

simple-git-hooks may not support `reference-transaction` as a hook event in all versions. If `npx simple-git-hooks` ignores the entry, install that one hook outside simple-git-hooks (directly into `.git/hooks/reference-transaction`) — it lives at a separate hook name from the others, so simple-git-hooks won't touch it.

## Bring-your-own mode

`git embedded print-hook-script <name>` outputs the script body. You can use it via the `npx` indirection above, or inline its contents into the `package.json` command if you want to avoid the indirect call.
