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

## Development

```sh
claude plugin validate .
claude plugin validate plugins/idle-compact
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test plugins/idle-compact
```
