# @cldmv/git-embedded

[![npm version]][npm_version_url] [![npm downloads]][npm_downloads_url] [![Last commit]][last_commit_url] [![npm last update]][npm_last_update_url]

[![Contributors]][contributors_url] [![Sponsor shinrai]][sponsor_url]

Manage embedded git repositories (anonymous gitlinks) without `.gitmodules`. Provides hooks that restore standard git-command ergonomics for embedded child repos while keeping the child's origin URL out of the public parent repo.

## What this is

Git uses **gitlinks** internally to track sub-repositories: a tree entry of mode `160000` pointing at a specific commit SHA in another repository. Submodules are built on top of gitlinks, with a registry file (`.gitmodules`) that records the child's URL alongside the gitlink. The URL is what makes `git clone --recurse-submodules`, `git submodule update`, and `submodule.recurse=true` checkout-flavored automation work — but it's also what publicly advertises the child repo's existence and location.

A gitlink without a `.gitmodules` entry is sometimes called an "anonymous submodule" or "embedded git repo." It's a fully supported git state: the gitlink still pins a specific child SHA, git still recognizes the child as a submodule boundary, and the parent commits a clean reference to the child's pinned version. What's missing is git's automatic update behavior, because the submodule machinery requires registration to act.

This package fills that gap with two git hooks:

- **`reference-transaction`** — blocks `git checkout`, `git switch`, `git reset`, `git pull`, `git merge`, `git rebase`, `git bisect`, and `git cherry-pick` when any embedded child repo has uncommitted changes. Prevents the silent inconsistent-state failure mode where the parent moves to a new commit but the child stays behind, dirty.
- **`update-embedded-repos`** — installed as `post-checkout`, `post-merge`, and `post-rewrite`. After a HEAD-moving operation, walks every gitlink in the new HEAD and updates the embedded child to its pinned SHA, using the child's own `origin` remote to fetch missing commits.

Together, the two hooks make embedded gitlinks behave like properly-registered submodules for the common workflow operations — without ever recording the child's URL in the public parent repo.

## Why this matters

The motivating use case is OSS repositories that want comprehensive test coverage running in CI but cannot afford to publish the full test suite. Tests are a high-fidelity behavioral specification of the code under test; modern AI tooling makes clean-room reimplementation from tests fast and effective. Hiding the tests is the most direct mitigation. See [`docs/use-case-private-tests.md`](docs/use-case-private-tests.md) for the full motivation, threat model, and licensing strategy.

The mechanism is general, though. The hooks don't know or care that the embedded repo is a test suite — they work for any gitlink. Other plausible uses: private vendor directories, license-restricted dependencies, encrypted asset trees, internal tooling sub-repos.

## Install

```bash
npm install -g @cldmv/git-embedded
```

That places a `git-embedded` executable in npm's global `bin` directory, which makes git's subcommand discovery surface it as `git embedded …`.

## Usage

Run inside the parent repo (the one that holds the embedded gitlinks):

```bash
git embedded doctor          # inspect environment; takes no action
git embedded install-hooks   # install hooks into this repo's .git/hooks
git embedded uninstall-hooks # remove hooks installed by this CLI
```

`install-hooks` adapts to whatever's already in place:

- **Nothing configured** — offers to install a small dispatcher script at `~/.config/git/hooks/_dispatch`, link every standard hook name to it, and set `git config --global core.hooksPath` to that directory. Then drops this package's hook scripts into the repo's `.git/hooks/`. The dispatcher chains to per-repo hooks, so every other repo on the machine keeps working as before.
- **Canonical dispatcher already present** — installs only the per-repo hook scripts; the existing dispatcher activates them.
- **Dispatcher present but missing required entries** — offers to add the missing symlinks (with explicit confirmation), then installs per-repo hooks.
- **Foreign hook manager detected** (Husky, lefthook, simple-git-hooks, pre-commit) — refuses to install and prints instructions for hand-integrating, since clobbering those tools' generated files would be reverted on their next run.
- **Non-conforming dispatcher / bare `.githooks/`** — refuses and prints integration options; the CLI never rewrites someone else's dispatcher.

### Flags

```text
--no-symlinks             use hard links instead of symbolic links
                          (avoids the Windows UAC prompt; same-volume only)
--yes                     skip confirmation prompts
--dispatcher-dir <path>   override the default ~/.config/git/hooks
```

### Other subcommands

```bash
git embedded install-template   # install hooks into git config init.templateDir/hooks
                                # so new repos start with them already wired
git embedded print-hook-script <name>
                                # emit a packaged hook script to stdout
                                # (post-checkout / post-merge / post-rewrite /
                                #  reference-transaction / update-embedded-repos / _dispatch)
```

## Quick start: embed a child repo

After the hooks are installed:

```bash
git clone <private-child-url> embedded-child
git add embedded-child
git commit -m "embed child"

# silence the harmless 'embedded git repository' warning if desired
git config advice.addEmbeddedRepo false
```

The committed parent tree now contains a gitlink at `embedded-child` pinning the child's current HEAD. No `.gitmodules` is created; the child's URL never lands in the public repo.

`link` clones into a missing **or empty** target directory (a fresh clone of a parent materializes each gitlink as an empty dir, so `link` works to fill one in); it refuses only a non-empty directory. After staging, it also records the child's URL and branch into this clone's local registry (see below).

## Restoring embedded children (machine-B bootstrap)

The parent commits only anonymous gitlinks — a path and a pinned SHA, never a URL. So a fresh clone of the parent materializes each embedded child as an _empty directory_: git knows the pin but has nowhere to fetch it from. `git embedded restore` fills those directories in.

```bash
git clone <parent-url> myproject
cd myproject
git embedded restore          # clone every embedded child and check out its pinned SHA
```

`restore` resolves each child's clone URL from up to four **optional** sources, strictest first, stopping at the first that yields a URL:

1. **Local config registry** — `embedded.<path>.url` in _this clone's_ `.git/config`. Per-clone, never committed. Written automatically after a successful restore, and by `record` / `link`.
2. **Manifest file** (`--from <file>`) — a JSON transfer file carried out-of-band (never committed). See `export` below.
3. **`--base <url-base>`** — derives `<url-base>/<basename>.git` for each child.
4. **Convention** (zero state) — the child is a sibling of wherever the parent was cloned from: `dirname(parent origin) + "/" + basename(<path>) + ".git"`. No configuration, but it only resolves when the child's repository is actually named after the gitlink path and sits beside the parent. A convention guess can only ever name strings already derivable from the committed tree, so it discloses nothing new.

Every clone is **SHA-verified**: the parent's pinned commit must exist in the freshly cloned child (a `git fetch` is attempted first). If it doesn't — e.g. a convention guess resolved to the wrong repository — the clone `restore` created is removed and the child is reported `pinned-mismatch`. A wrong guess fails closed; it never plants the wrong code.

Per-child outcomes are `restored`, `already-present`, `unresolved`, `pinned-mismatch`, or `skipped`, and `restore` exits non-zero if any child ends `unresolved` or `pinned-mismatch`. Use `--dry-run` to report resolution without cloning.

**Partial restore is the normal case.** A public contributor without access to a private child simply skips it:

```bash
git embedded restore --skip tests            # comma-separate several: --skip tests,vendor/foo
```

### Obscured children

A child whose repository name does not match its gitlink path — the intended state for a hidden private child — is deliberately _not_ convention-resolvable. Provide its URL once (via `link` into the empty gitlink dir, or `record` if it is already cloned) and this clone's registry remembers it for every later restore:

```bash
git embedded link tests git@example.com:org/private-tests.git
# ...or, if the child is already present on disk:
git embedded record
```

### Sharing URLs between machines: `export` / `record`

`record` writes the origin URL (and current branch) of every present child into the local registry. `export` serializes that registry to a manifest another machine can consume:

```bash
git embedded export --scan -o children.json   # record present children, then write the manifest
```

On the other machine:

```bash
git clone <parent-url> myproject && cd myproject
git embedded restore --from children.json
```

> **Never commit the manifest.** It contains the very URLs the anonymous-gitlink design keeps out of the tree. When `export -o` writes inside the worktree it appends the filename to `.git/info/exclude` as a courtesy, but keeping the manifest out-of-band is your responsibility.

## Manual install (no CLI)

If you'd rather wire things up by hand:

```bash
mkdir -p .githooks
cp /path/to/git-embedded/hooks/reference-transaction .githooks/
cp /path/to/git-embedded/hooks/update-embedded-repos .githooks/
chmod +x .githooks/*

ln -sf update-embedded-repos .githooks/post-checkout
ln -sf update-embedded-repos .githooks/post-merge
ln -sf update-embedded-repos .githooks/post-rewrite

git config core.hooksPath .githooks
```

## Documentation

- [`docs/design.md`](docs/design.md) — how the hooks work, coverage matrix, limitations, comparison to standard submodules.
- [`docs/use-case-private-tests.md`](docs/use-case-private-tests.md) — the OSS-tests-in-private-repo motivation, threat model, licensing strategy, why anonymous gitlinks rather than alternatives.

## Compatibility

- **Git 2.28 or newer** for the `reference-transaction` hook (released July 2020). The `update-embedded-repos` hook works on older git but loses its guard.
- **Node 20.19+** for the CLI. The hooks themselves are shell scripts with no Node dependency at hook execution time.
- **Linux / macOS / Windows.** On Windows, symlink creation needs admin elevation (a one-shot UAC prompt the CLI requests). Pass `--no-symlinks` to use hard links instead and skip the prompt.

## Links

- **npm**: [@cldmv/git-embedded](https://www.npmjs.com/package/@cldmv/git-embedded)
- **GitHub**: [CLDMV/git-embedded](https://github.com/CLDMV/git-embedded)
- **Issues**: [GitHub Issues](https://github.com/CLDMV/git-embedded/issues)
- **Releases**: [GitHub Releases](https://github.com/CLDMV/git-embedded/releases)

## License

[![GitHub license]][github_license_url] [![npm license]][npm_license_url]

Apache-2.0 © Shinrai / CLDMV. See [LICENSE](LICENSE).

[npm version]: https://img.shields.io/npm/v/%40cldmv%2Fgit-embedded.svg?style=for-the-badge&logo=npm&logoColor=white&labelColor=CB3837
[npm_version_url]: https://www.npmjs.com/package/@cldmv/git-embedded
[npm downloads]: https://img.shields.io/npm/dm/%40cldmv%2Fgit-embedded.svg?style=for-the-badge&logo=npm&logoColor=white&labelColor=CB3837
[npm_downloads_url]: https://www.npmjs.com/package/@cldmv/git-embedded
[npm last update]: https://img.shields.io/npm/last-update/%40cldmv%2Fgit-embedded?style=for-the-badge&logo=npm&logoColor=white&labelColor=CB3837
[npm_last_update_url]: https://www.npmjs.com/package/@cldmv/git-embedded
[last commit]: https://img.shields.io/github/last-commit/CLDMV/git-embedded?style=for-the-badge&logo=github&logoColor=white&labelColor=181717
[last_commit_url]: https://github.com/CLDMV/git-embedded/commits
[contributors]: https://img.shields.io/github/contributors/CLDMV/git-embedded.svg?style=for-the-badge&logo=github&logoColor=white&labelColor=181717
[contributors_url]: https://github.com/CLDMV/git-embedded/graphs/contributors
[sponsor shinrai]: https://img.shields.io/github/sponsors/shinrai?style=for-the-badge&logo=githubsponsors&logoColor=white&labelColor=EA4AAA&label=Sponsor
[sponsor_url]: https://github.com/sponsors/shinrai
[github license]: https://img.shields.io/github/license/CLDMV/git-embedded.svg?style=for-the-badge&logo=github&logoColor=white&labelColor=181717
[github_license_url]: https://github.com/CLDMV/git-embedded/blob/HEAD/LICENSE
[npm license]: https://img.shields.io/npm/l/%40cldmv%2Fgit-embedded.svg?style=for-the-badge&logo=npm&logoColor=white&labelColor=CB3837
[npm_license_url]: https://www.npmjs.com/package/@cldmv/git-embedded
