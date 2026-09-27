# claude-plugins

Personal [Claude Code](https://code.claude.com) plugins.

```
/plugin marketplace add itkrt2y/claude-plugins
```

## Plugins

### idle-compact

Compacts the main conversation once after 40 idle minutes, while the 1h prompt cache is still warm, so the next turn after a long break starts from a small context instead of re-caching the whole one.

- The timer starts when a turn you sent completes, and is cancelled by a new turn, a manual or automatic compaction, or the end of the session.
- It compacts once and does not re-arm until you send another message.
- A timer that fires 55 minutes or more after the turn (for example after the machine slept) does nothing, since the cache may already be cold.
- Failed compactions are not retried.

Function hooks are early access: set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, for example in the `env` block of `~/.claude/settings.json`.

```
/plugin install idle-compact@itkrt2y-claude-plugins
```

Inspired by [takahirom's idle-compact](https://github.com/takahirom/takahirom-claude-code-marketplace/tree/main/plugins/idle-compact).

### review-threads

Respond to pull request review threads with the `respond-reviews` skill. One script, `scripts/review-threads.sh`, lists unresolved threads as JSON, replies inside a thread, resolves threads and edits posted replies, so Claude does not hand-write GraphQL queries each time. Requires `gh` and `jq`.

```
/plugin install review-threads@itkrt2y-claude-plugins
```

### rebase

The `rebase` skill tries `git rebase` in the main conversation and hands the rebase to a subagent only when it stops on conflicts, so conflict diffs and git output stay out of the main context. The subagent never pushes.

```
/plugin install rebase@itkrt2y-claude-plugins
```

### circleci-triage

The `circleci-triage` skill fetches failed CircleCI tests with the `circleci` CLI in a subagent, then tells flaky failures from regressions by reading the actual values and reproducing locally.

```
/plugin install circleci-triage@itkrt2y-claude-plugins
```

### project-memory

- A SessionStart hook injects `~/.claude/projects/<project>/RULES.md` as always-on rules for that project. Claude Code's auto memory loads only the first 200 lines or 25KB of `memory/MEMORY.md`; turn on the `inject_memory_index` option to inject the whole index as well.
- The `memory-index-compact` skill shortens `MEMORY.md` when it nears the limit while keeping every link and every status of unfinished work.

```
/plugin install project-memory@itkrt2y-claude-plugins
```

### desktop-notify

Shows Claude Code notifications on the GNOME desktop, titled with the session name set by `/rename`, else the git branch, else the directory name, so you can tell parallel sessions apart.

Supported environment: a local GNOME session on Linux. Tested with GNOME Shell 50 (Wayland) on Fedora 44. Other desktops, macOS, WSL, and SSH or headless sessions without a notification server are not supported.

Requirements (Fedora package names in parentheses):

- `notify-send` (`libnotify`)
- `jq` (`jq`)
- `tac` and `timeout` from GNU coreutils (`coreutils`)
- Optional: `canberra-gtk-play` (`libcanberra-gtk3`) and the freedesktop sound theme (`sound-theme-freedesktop`) to play a sound. Without them, notifications are silent.

```
/plugin install desktop-notify@itkrt2y-claude-plugins
```

## Development

```sh
claude plugin validate .
for p in plugins/*/; do claude plugin validate "$p"; done
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test plugins/idle-compact
```
