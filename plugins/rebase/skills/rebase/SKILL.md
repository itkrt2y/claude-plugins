---
name: rebase
description: Run git rebase in the main conversation and hand conflict resolution to a subagent only when conflicts occur, so conflict diffs and noisy git output stay out of the main context. Use for "rebase onto main", "rebase this branch", "catch up with the base branch", rebaseして, or /rebase [base].
---

# Rebase with conflicts delegated to a subagent

Try the rebase in the main conversation first. Only when it stops on conflicts, abort and delegate the whole rebase to a subagent.

## Why

Every turn resends the whole conversation. Conflict diffs and git output left in the main conversation are paid for again on every later turn. A subagent works in its own context, and only its summary comes back. Starting a subagent unconditionally costs more than it saves when the rebase is clean, which is the common case, so delegate only on conflict.

## Steps

### 1. Pick the base branch

- With an argument, rebase onto it (`/rebase main` → `main`).
- Without one, ask which branch to rebase onto.

### 2. Enable rerere

```sh
git config rerere.enabled true
```

rerere replays earlier resolutions when the same conflict comes back, which saves work when a rebase is redone. It also replays a wrong resolution. If one was recorded, drop it with `git rerere forget <path>` before resolving again.

### 3. Try the fast path in the main conversation

```sh
git rebase <base>
```

- **No conflicts** → done.
- **Conflicts** → `git rebase --abort`, then go to step 4.

**Sandbox and worktrees.** When the sandbox denies writes to some paths the rebase must touch (common inside git worktrees, or when the base changes files under `.claude/`), checkout fails with `Read-only file system` and stops at `could not detach HEAD`. That failure is unrelated to conflicts. HEAD and commits are untouched, but the working tree holds part of the base's content. If it happens:

1. Confirm HEAD did not move: `git rev-parse HEAD`.
2. Discard tracked changes: `git checkout -- .`
3. For leftover untracked files, confirm with `git ls-tree -r <base> --name-only -- <path>` that they exist in the base, then move them to the scratchpad instead of deleting them. The rebase will restore them from the base.
4. Rerun the rebase with the sandbox disabled, after the user approves.

Once you know a repository hits this, skip the sandboxed attempt and run the rebase unsandboxed from the start.

### 4. Delegate to a subagent (only on conflict)

Start an Agent with `subagent_type: general-purpose` and `model: "sonnet"`. Conflict resolution needs code understanding, a guess at each commit's intent, and the judgment to leave unclear cases unresolved, so do not use a smaller model. Never let the full diff come back to the main conversation.

Prompt:

> Run `git rebase <base>` and resolve the conflicts.
> - Use `git status` to find conflicted files, and read and edit **only those files**. Do not read or diff unrelated files.
> - Resolve each conflict from the file contents and the intent of the commits (`git log --oneline <base>..HEAD`). Leave a conflict unresolved and report it when the right resolution is unclear.
> - If a commit on this branch was already squash-merged into the base and conflicts as add/add, confirm the content matches with `git diff HEAD..<commit> -- <file>` and then `git rebase --skip`.
> - **Do not push, force-push or otherwise publish history.**
> - If the sandbox blocks writing a file, stop and report it instead of working around it.
> - Return only this summary, never full diffs or verbose git output:
>   1. Result: succeeded / aborted / needs a decision
>   2. Resolved files, one line each with the resolution
>   3. Places that need a human decision
>   4. A short summary of the final `git status`

### 5. Relay the result

- Pass the summary to the user.
- For "needs a decision", inspect those spots in the main conversation, then resolve them by hand or delegate again with more instructions.
- If the branch needs a force-push, ask the user and run it from the main conversation. The subagent never pushes.

## Notes

- Large or tangled conflicts may need more than one delegation, or a switch to manual resolution.
- After a sandbox failure, a subagent may clean up with `git checkout -- .` or `rm`, and a security monitor may warn about deleted tracked files. Check with `git ls-tree -r HEAD --name-only` whether each file exists in the **current** HEAD. If it does not, it came from the aborted checkout and removing it was correct.
- After `git rebase --abort`, untracked files from the base can remain in the working tree. Move them aside before rebasing again.
