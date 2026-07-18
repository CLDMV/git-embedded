# Design: hooks for embedded git repositories

This document describes the hook system that `@cldmv/git-embedded` installs and the design choices behind it. It is intended for anyone evaluating the approach, debugging an installed hook, or working on the planned CLI.

## Background: gitlinks, submodules, and the registration gap

Git internally tracks embedded sub-repositories as **gitlinks**: a tree entry with mode `160000` whose "value" is a 40-character commit SHA. The gitlink is the actual pinning machinery — it records "this directory should be at commit X" in the parent's history.

Submodules are layered on top of gitlinks. A submodule is a gitlink **plus** a registry entry that declares the submodule's URL and (optionally) other configuration. The registry lives in two places:

- `.gitmodules` — a tracked file at the parent repo root. The committed source of truth. Contains `[submodule "name"] path = ..., url = ...` blocks.
- `.git/config` — the local-only runtime view, populated from `.gitmodules` by `git submodule init`.

Git's high-level submodule commands (`git submodule update`, `submodule.recurse=true` behavior in `checkout`/`switch`/`pull`/`bisect`, `git clone --recurse-submodules`) require an entry in the registry to operate. They do not infer submodules from the mere presence of a gitlink and an embedded `.git/` directory, even though the information needed to do so is locally available.

This produces what this package calls the **registration gap**: a gitlink that has no registry entry is fully tracked at the tree level (the SHA pin travels with commits, `git status` still flags divergence between the tree and the working state, `git add` infers the new SHA from the child's HEAD), but the working-tree-update automation is silent. Standard `git checkout` moves the parent forward; the embedded child stays at whatever SHA it was at before the operation.

The hooks in this package close the registration gap without requiring a registry entry. They use the gitlink SHA from the parent's tree directly (via `git ls-tree`) and the child's own `origin` remote configuration (which the child has if it was cloned normally) to do the same work `git submodule update` would do.

## Why this matters: the URL is the leak

For most submodule use cases, the URL in `.gitmodules` is uncontroversial — the parent is open and the child is open, the URL is just a convenience for `clone --recurse-submodules`. For a parent that wants to hide the _existence_ of a private child repo, the `.gitmodules` URL is the leak. Anyone who can read the public parent can read `.gitmodules`, see the URL of the private child, and at minimum learn that a private resource exists at that location.

Avoiding `.gitmodules` is the obvious fix, but doing so loses the working-tree automation. This package restores the automation while keeping the parent free of URL data.

## The two hooks

### `reference-transaction` (guard)

**Purpose.** Refuse to apply HEAD-moving ref updates when any embedded child repo has uncommitted changes. Without this guard, a `git checkout B` in the parent silently leaves a dirty child stranded at the previous pin, producing an inconsistent state that is easy to miss.

**Mechanism.** `reference-transaction` is a git hook introduced in git 2.28 (July 2020). It fires for any ref-update transaction with one of three phase arguments:

- `prepared` — updates queued, not yet applied. Exiting non-zero ABORTS the transaction.
- `committed` — updates already applied.
- `aborted` — informational.

The hook script acts only on the `prepared` phase, where rejection is possible. It reads the proposed ref updates from stdin (one `old_sha new_sha ref` per line) and filters to lines where `ref` is `HEAD` with `old_sha != new_sha` (a HEAD move).

**A plumbing fact that shapes the design:** a plain `git commit` ALSO emits a HEAD update line in the reference transaction (HEAD's reflog records the new commit), so "HEAD moved" alone cannot distinguish a commit from a checkout. An earlier revision of this document claimed commits were not caught; that was wrong, and the hook now reasons about what the move would actually do to each child instead of assuming the operation's type. Where the type matters (strict mode), append vs jump is classified by parentage: a move whose NEW commit lists the current (pre-move) HEAD among its parents is an append (commit, merge, cherry-pick step); everything else is a jump (checkout, switch, reset, bisect). The pre-move HEAD is resolved directly — the transaction line's old value reads as the null SHA on a checkout-to-SHA detach and must not be trusted for this. One known edge: switching to a branch whose tip is a direct child of the current HEAD is indistinguishable from a commit by parentage and classifies as an append.

**Guard modes** (`git config embedded.guard`, local over global; two-part settings keys in the `embedded.*` section are structurally reserved — registry entries are always three-part `embedded.<path>.url|branch`):

- `precise` _(default)_ — block only when a DIRTY child's HEAD differs from the pin recorded in the NEW commit: exactly the condition under which `update-embedded-repos` would try to move a child carrying uncommitted changes. A clean child never blocks; a dirty child whose pin equals its HEAD never blocks (the sync no-ops). This lets a parent evolve — including plain commits and pin bumps — while unrelated children are mid-work.
- `strict` — the everything-synced policy for workspaces that want the parent to only ever snapshot a fully-committed state. Any dirty child blocks any HEAD move, and on APPENDS every child's pin in the new commit must equal that child's current HEAD — so a parent commit can never ship a stale pin (work done in a child but not recorded in the parent). Jumps only require all-clean: their pins are expected to differ, and the post-hook sync moves the (clean) children afterwards.
- `off` — no guarding.

One-shot override for any mode: `git -c embedded.guard=<mode> <command>`. "Dirty" is `git diff-index --quiet HEAD` semantics — modified/staged tracked files; untracked files never count.

**What it catches.** Every git command that updates HEAD in a reference transaction: `git commit`, `git checkout <ref>`, `git switch <branch>`, `git reset`, `git pull`, `git merge`, `git rebase` (each step), `git bisect` (each step), `git cherry-pick`, and others — with per-mode rules as above.

**What it does not catch.** Operations that don't move HEAD: `git checkout -- file` (file-level checkout), `git stash` itself (records stash refs, not HEAD), bare index edits. These don't trigger child-update behavior, so there is nothing to guard.

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

### `pre-push` (pin publication check)

**Purpose.** Refuse to push parent commits whose gitlink pins reference child commits that are not reachable from the child's own origin. Without this, a parent that pins a committed-but-unpushed child publishes a dangling pointer: every other machine's `git embedded restore` fails on that child with `pinned-mismatch`, because the child's origin has never seen the commit. The dirty-state guard cannot catch this — a committed-but-unpushed child is clean.

This is git-embedded's analog of `git push --recurse-submodules=check`; stock git cannot provide it here because that machinery locates children via `.gitmodules` registration, which anonymous gitlinks deliberately omit — the same registration gap the other hooks close for checkout.

**Mechanism.** For each pushed ref, the hook collects the gitlink pins the remote is about to learn: the pins _changed_ by each commit new to the remote (`git diff-tree`, cheap), plus — only when the remote ref is being _created_ — every gitlink in the tip's tree. Each unique `(path, pin)` is verified inside the child working copy: reachable from some `refs/remotes/origin/*` tip, with one `git fetch origin` refresh on a miss so stale tracking refs don't produce false rejections. A pin change for a child that is not present in the working tree is rejected (it cannot be verified). Because only _newly-introduced_ pins are checked on existing-ref updates, a clone that never restored its children can still push commits that touch no pin.

**Modes** (`git config embedded.pushRecurse`, local over global):

- `check` _(default)_ — reject the push with a "push the child first" message.
- `on-demand` — first try to publish the pin by pushing the child's CURRENT branch (only when that branch contains the pin and the child is not detached), then fall back to `check`'s rejection. Opt-in because implicitly pushing a child branch as a side effect of a parent push is surprising.
- `off` — no verification.

One-shot override: `git -c embedded.pushRecurse=<mode> push …`.

- `git stash pop` modifies the working tree without moving HEAD. It does not affect embedded children (stash entries are recorded in the parent's stash ref, not in the children), but anyone expecting "all working-tree-modifying commands are guarded" will not see consistency here.

## Coverage matrix

| Operation                           | `reference-transaction` (guard)                                                        | `update-embedded-repos` (update)                     |
| ----------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `git checkout <ref>`                | Refuses if any child is dirty                                                          | Updates children to new pins                         |
| `git switch <branch>`               | Refuses if any child is dirty                                                          | Updates children to new pins                         |
| `git reset --hard <commit>`         | Refuses if any child is dirty                                                          | **Gap** — does not fire `post-*` hooks               |
| `git reset --soft/--mixed <commit>` | Refuses if any child is dirty (HEAD moves)                                             | Does not fire `post-*` hooks (HEAD-only change)      |
| `git pull` (fast-forward)           | Refuses if any child is dirty                                                          | Updates children                                     |
| `git pull --rebase`                 | Refuses at each rebase step                                                            | Updates children after rebase completes              |
| `git merge <commit>`                | Refuses if any child is dirty                                                          | Updates children via `post-merge`                    |
| `git rebase`                        | Refuses at each step                                                                   | Updates children via `post-rewrite`                  |
| `git bisect <good/bad/run>`         | Refuses if any child is dirty                                                          | Updates children at each bisect step                 |
| `git cherry-pick`                   | Refuses if any child is dirty                                                          | Updates children via `post-checkout`                 |
| `git stash pop`                     | Not guarded (no HEAD move)                                                             | Not updated (no HEAD move; not needed)               |
| `git commit`                        | Refuses (precise: a dirty child it would re-pin; strict: any dirty child or stale pin) | Not updated (records current pins; no `post-*` hook) |
| `git checkout -- file`              | Not guarded (no HEAD move)                                                             | Not updated (no HEAD move; not needed)               |

## Comparison to standard submodules

| Property                     | Standard submodule        | Anonymous gitlink + these hooks             |
| ---------------------------- | ------------------------- | ------------------------------------------- |
| Child URL in parent          | Yes, in `.gitmodules`     | No                                          |
| Tree-level pin               | Gitlink                   | Gitlink                                     |
| Public viewer sees           | URL, path, current SHA    | Just the SHA (no link to follow)            |
| `git submodule update`       | Works                     | Not used (registry-bound; hooks replace it) |
| `submodule.recurse=true`     | Works                     | Not used (registry-bound; hooks replace it) |
| `git status` divergence      | Yes                       | Yes                                         |
| `git add path` infers SHA    | Yes                       | Yes                                         |
| `--recurse-submodules` clone | Pulls child               | No-op (no registry)                         |
| Initial child clone          | Automatic via registry    | Manual or via the planned CLI               |
| Dirty-child guard            | Default refuses on update | Hook refuses on the HEAD move itself        |

The most useful difference is the **guard timing**. Standard submodules let the parent operation proceed and then refuse the child update, leaving the developer in a parent-moved-child-stale state that has to be backed out. The `reference-transaction` guard refuses the whole transaction at the parent level, so the working tree never reaches the inconsistent state.

## Implementation notes

- The hooks are POSIX-shell scripts to avoid Node or other runtime dependencies at hook execution time. They use `git ls-tree`, `git diff-index`, `git rev-parse`, `git cat-file`, `git fetch`, and `git checkout` — all standard plumbing.
- All hook scripts are idempotent. Running them twice in a row is harmless: the second invocation detects the children are already at the pinned SHAs and is a no-op.
- The `update-embedded-repos` script always exits 0. A failure to update a child writes to stderr but does not signal failure to git, because the parent operation has already completed and signalling failure here would not undo it. The `reference-transaction` guard is what prevents getting into this state.
- The hooks operate on `HEAD`'s tree, not the index. This is correct after a checkout (HEAD has been updated), correct after a merge (HEAD is the merge commit), and correct after a rewrite (HEAD is the new commit). Reading the index instead would be wrong in some merge cases.
- Embedded children are detected by the presence of `<path>/.git` (a directory for normal clones, a file for worktrees or for child submodules that have been moved into the gitdir). The check `[ -d "$path/.git" ] || [ -f "$path/.git" ]` covers both.
