# Design: hooks for embedded git repositories

This document describes the hook system that `@cldmv/git-embedded` installs and the design choices behind it. It is intended for anyone evaluating the approach, debugging an installed hook, or working on the CLI.

## Background: gitlinks, submodules, and the registration gap

Git internally tracks embedded sub-repositories as **gitlinks**: a tree entry with mode `160000` whose "value" is a 40-character commit SHA. The gitlink is the actual pinning machinery — it records "this directory should be at commit X" in the parent's history.

Submodules are layered on top of gitlinks. A submodule is a gitlink **plus** a registry entry that declares the submodule's URL and (optionally) other configuration. The registry lives in two places:

- `.gitmodules` — a tracked file at the parent repo root. The committed source of truth. Contains `[submodule "name"] path = ..., url = ...` blocks.
- `.git/config` — the local-only runtime view, populated from `.gitmodules` by `git submodule init`.

Git's high-level submodule commands (`git submodule update`, `submodule.recurse=true` behavior in `checkout`/`switch`/`pull`/`bisect`, `git clone --recurse-submodules`) require an entry in the registry to operate. They do not infer submodules from the mere presence of a gitlink and an embedded `.git/` directory, even though the information needed to do so is locally available.

This produces what this package calls the **registration gap**: a gitlink that has no registry entry is fully tracked at the tree level (the SHA pin travels with commits, `git status` still flags divergence between the tree and the working state, `git add` infers the new SHA from the child's HEAD), but the working-tree-update automation is silent. Standard `git checkout` moves the parent forward; the embedded child stays at whatever SHA it was at before the operation.

The hooks in this package close the registration gap without requiring a registry entry. They use the gitlink SHA from the parent's tree directly (via `git ls-tree`) and the child's own `origin` remote configuration (which the child has if it was cloned normally) to do the same work `git submodule update` would do.

## Why this matters: the URL is the leak

For most submodule use cases, the URL in `.gitmodules` is uncontroversial — the parent is open and the child is open, the URL is just a convenience for `clone --recurse-submodules`. For a parent that wants to hide the *existence* of a private child repo, the `.gitmodules` URL is the leak. Anyone who can read the public parent can read `.gitmodules`, see the URL of the private child, and at minimum learn that a private resource exists at that location.

Avoiding `.gitmodules` is the obvious fix, but doing so loses the working-tree automation. This package restores the automation while keeping the parent free of URL data.

## The two hooks

### `reference-transaction` (guard)

**Purpose.** Refuse to apply HEAD-moving ref updates when any embedded child repo has uncommitted changes. Without this guard, a `git checkout B` in the parent silently leaves a dirty child stranded at the previous pin, producing an inconsistent state that is easy to miss.

**Mechanism.** `reference-transaction` is a git hook introduced in git 2.28 (July 2020). It fires for any ref-update transaction with one of three phase arguments:

- `prepared` — updates queued, not yet applied. Exiting non-zero ABORTS the transaction.
- `committed` — updates already applied.
- `aborted` — informational.

The hook script acts only on the `prepared` phase, where rejection is possible. It reads the proposed ref updates from stdin (one `old_sha new_sha ref` per line), filters to lines where `ref` is `HEAD` and `old_sha != new_sha` (an actual HEAD move), and walks every gitlink in the current tree checking for uncommitted changes via `git diff-index --quiet HEAD --` inside each child. If any child is dirty, the hook prints a message to stderr and exits non-zero, which aborts the parent operation.

**What it catches.** Every git command that ultimately moves HEAD goes through a reference transaction. That includes `git checkout <ref>`, `git switch <branch>`, `git reset` (any mode that moves HEAD), `git pull` (both fast-forward and rebase variants), `git merge`, `git rebase` (each step), `git bisect` (each step), `git cherry-pick`, and others.

**What it does not catch.** Operations that don't move HEAD aren't guarded, by design: `git commit` (creates a new commit but doesn't update the gitlink without explicit staging), `git checkout -- file` (file-level checkout), `git stash` itself (records stash refs, not HEAD), and so on. These don't require child-update behavior.

**Caveat about error messaging.** When the hook exits non-zero, git wraps its own message around the script's stderr output. The user sees a message like:

```text
git-embedded: ✗ embedded-child has uncommitted changes
  commit or stash inside embedded-child/ before moving HEAD here
fatal: reference transaction hook declined
```

The `fatal: reference transaction hook declined` line is from git, not the hook. The script's two lines above it are what the user actually needs. Hook output should remain short and unambiguous because it appears alongside git's wrapping.

### `update-embedded-repos` (auto-update)

**Purpose.** After a successful HEAD-moving operation in the parent, walk every gitlink in the new HEAD and update the corresponding embedded child to its pinned SHA. This is the post-condition that `git submodule update` provides for registered submodules; the hook provides the equivalent for unregistered gitlinks.

**Mechanism.** A single script installed under three hook names: `post-checkout`, `post-merge`, and `post-rewrite`. Each of these fires after a different family of operations:

- `post-checkout` — `git checkout`, `git switch`, `git clone` (for the initial checkout), and each step of `git bisect`. Also fires when `git pull` does a fast-forward checkout-style update.
- `post-merge` — successful `git merge` and the merge phase of `git pull`.
- `post-rewrite` — `git rebase`, `git commit --amend`, and any command that rewrites commits.

For each gitlink path, the script:

1. Reads the pinned SHA from `git ls-tree -r HEAD`.
2. Confirms a working git repo exists at the path (`tests/.git` is a directory or file).
3. Compares the pinned SHA to the child's current HEAD; skips if already in sync.
4. If the pinned SHA is not in the child's local object store, runs `git fetch` inside the child (using the child's own remote config — `.gitmodules` is not consulted).
5. Runs `git checkout --detach <sha>` inside the child.

The detached-HEAD checkout matches standard submodule behavior: parents pin specific commits, not branches, so the child ends up in detached-HEAD state after each parent operation. If the child needs to be on a branch for editing, the developer attaches to one (`git -C embedded-child switch -c work` or `git -C embedded-child checkout main`) after the operation completes.

**What it catches.** Together, the three hook names cover essentially every checkout-flavored parent operation. See the coverage matrix below.

**What it does not catch.** Two notable gaps:

- `git reset --hard <commit>` updates the index and working tree but does **not** fire `post-checkout`, `post-merge`, or `post-rewrite`. The `reference-transaction` guard catches this case at the prepared phase (because `reset` does move HEAD via a ref transaction), so a `--hard` reset with a dirty child is refused — but a `--hard` reset with a clean child completes without the children being auto-updated. The mitigation is to either accept the gap, manually re-run the script, or use a `git-foo` wrapper command.
- `git stash pop` modifies the working tree without moving HEAD. It does not affect embedded children (stash entries are recorded in the parent's stash ref, not in the children), but anyone expecting "all working-tree-modifying commands are guarded" will not see consistency here.

## Coverage matrix

| Operation | `reference-transaction` (guard) | `update-embedded-repos` (update) |
|---|---|---|
| `git checkout <ref>` | Refuses if any child is dirty | Updates children to new pins |
| `git switch <branch>` | Refuses if any child is dirty | Updates children to new pins |
| `git reset --hard <commit>` | Refuses if any child is dirty | **Gap** — does not fire `post-*` hooks |
| `git reset --soft/--mixed <commit>` | Refuses if any child is dirty (HEAD moves) | Does not fire `post-*` hooks (HEAD-only change) |
| `git pull` (fast-forward) | Refuses if any child is dirty | Updates children |
| `git pull --rebase` | Refuses at each rebase step | Updates children after rebase completes |
| `git merge <commit>` | Refuses if any child is dirty | Updates children via `post-merge` |
| `git rebase` | Refuses at each step | Updates children via `post-rewrite` |
| `git bisect <good/bad/run>` | Refuses if any child is dirty | Updates children at each bisect step |
| `git cherry-pick` | Refuses if any child is dirty | Updates children via `post-checkout` |
| `git stash pop` | Not guarded (no HEAD move) | Not updated (no HEAD move; not needed) |
| `git commit` | Not guarded (no HEAD move) | Not updated (no HEAD move; not needed) |
| `git checkout -- file` | Not guarded (no HEAD move) | Not updated (no HEAD move; not needed) |

## Comparison to standard submodules

| Property | Standard submodule | Anonymous gitlink + these hooks |
|---|---|---|
| Child URL in parent | Yes, in `.gitmodules` | No |
| Tree-level pin | Gitlink | Gitlink |
| Public viewer sees | URL, path, current SHA | Just the SHA (no link to follow) |
| `git submodule update` | Works | Not used (registry-bound; hooks replace it) |
| `submodule.recurse=true` | Works | Not used (registry-bound; hooks replace it) |
| `git status` divergence | Yes | Yes |
| `git add path` infers SHA | Yes | Yes |
| `--recurse-submodules` clone | Pulls child | No-op (no registry) |
| Initial child clone | Automatic via registry | `git embedded restore` (SHA-verified; see [Provisioning](#provisioning-restoring-embedded-children)) |
| Dirty-child guard | Default refuses on update | Hook refuses on the HEAD move itself |

The most useful difference is the **guard timing**. Standard submodules let the parent operation proceed and then refuse the child update, leaving the developer in a parent-moved-child-stale state that has to be backed out. The `reference-transaction` guard refuses the whole transaction at the parent level, so the working tree never reaches the inconsistent state.

## Provisioning: restoring embedded children

The hooks above keep an *already-cloned* child in sync with the parent's pin. They do not perform the *initial* clone, because the parent tree deliberately records no URL to clone from. Standard submodules get the initial clone from the `.gitmodules` registry; anonymous gitlinks need another way to answer "where does this child come from?" without committing the answer.

`git embedded restore` is that mechanism. It enumerates the gitlinks in HEAD (the same `git ls-tree -r HEAD`, mode-`160000` walk the hooks use) and, for every child that is missing, empty, or lacks a `.git`, resolves a clone URL, clones, verifies, and checks out the pin. The design's core property holds throughout: child URLs are never committed.

### URL knowledge lives in three optional layers

URL knowledge is never in the committed tree. It can only come from one of three optional layers, tried strictest-first at resolve time:

1. **Local config registry** — `embedded.<path>.url` / `embedded.<path>.branch` in the parent clone's `.git/config`. Per-clone, never committed, never leaves the machine that wrote it. This is the durable record: a successful restore writes it, as do `record` and `link`.
2. **Manifest** — a JSON transfer file (`{ "version": 1, "children": { "<path>": { "url": …, "branch": … } } }`) passed via `--from`. It is a transfer format only: it lives outside any repo, in the operator's hands, and is never committed. `export` produces it from the registry; `restore --from` consumes it.
3. **Convention** — with zero recorded state, the child is assumed to be a sibling of wherever the parent was cloned from: `dirname(parent remote.origin.url) + "/" + basename(<path>) + ".git"`.

`--base <url-base>` sits between the manifest and convention as an explicit one-off override (`<url-base>/<basename>.git`), useful when children live under a known base that differs from the parent's origin.

### Why convention discloses nothing

The convention layer looks like it might leak, but it cannot reveal anything not already implied by the committed tree. The gitlink path (e.g. `tests`) and the parent's own origin are both already visible to anyone who has the parent. Convention only *combines* them into a guess — it invents no new information — and because the guess is a guess, it is not trusted. It is SHA-verified.

### SHA verification makes wrong guesses fail closed

After every clone, the parent's pinned SHA must exist in the cloned child (`git cat-file -e <sha>^{commit}`, retried once after a `git fetch origin`). If it is absent, the clone `restore` created is removed — never a pre-existing directory — and the child is reported `pinned-mismatch` with a non-zero exit. A convention guess that resolves to the wrong repository (or an out-of-date one) therefore fails closed rather than silently planting unrelated code at the pinned path. Only a repository that actually contains the pinned commit is accepted.

An *obscured* child — one whose repository name does not match its gitlink path — is by construction not convention-resolvable, which is exactly the property that keeps a private child hidden. Such a child is reachable only through layer 1 or layer 2: someone with access records its URL (via `link` or `record`) or is handed a manifest. A public cloner without either simply `--skip`s it; partial restore is the expected outcome, not an error.

### The commands

- `restore [paths…] [--from <manifest>] [--base <url-base>] [--skip <paths>] [--dry-run]` — resolve, clone, SHA-verify, detach-checkout the pin, and record the resolved URL. Per-child outcome is one of `restored`, `already-present`, `unresolved`, `pinned-mismatch`, `skipped`; the command exits non-zero when any non-skipped child ends `unresolved` or `pinned-mismatch`.
- `record [paths…]` — write each present child's `remote.origin.url` and current branch into the registry.
- `export [-o <file>] [--scan]` — serialize the registry to a manifest (stdout by default; `--scan` records first). The manifest must never be committed; when `-o` writes inside the worktree the filename is appended to `.git/info/exclude` as a courtesy.
- `link <path> <url>` — clone a child into a missing or empty gitlink directory, stage the gitlink, and record its URL.

## Implementation notes

- The hooks are POSIX-shell scripts to avoid Node or other runtime dependencies at hook execution time. They use `git ls-tree`, `git diff-index`, `git rev-parse`, `git cat-file`, `git fetch`, and `git checkout` — all standard plumbing.
- All hook scripts are idempotent. Running them twice in a row is harmless: the second invocation detects the children are already at the pinned SHAs and is a no-op.
- The `update-embedded-repos` script always exits 0. A failure to update a child writes to stderr but does not signal failure to git, because the parent operation has already completed and signalling failure here would not undo it. The `reference-transaction` guard is what prevents getting into this state.
- The hooks operate on `HEAD`'s tree, not the index. This is correct after a checkout (HEAD has been updated), correct after a merge (HEAD is the merge commit), and correct after a rewrite (HEAD is the new commit). Reading the index instead would be wrong in some merge cases.
- Embedded children are detected by the presence of `<path>/.git` (a directory for normal clones, a file for worktrees or for child submodules that have been moved into the gitdir). The check `[ -d "$path/.git" ] || [ -f "$path/.git" ]` covers both.
