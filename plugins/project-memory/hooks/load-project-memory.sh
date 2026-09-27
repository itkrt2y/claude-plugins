#!/usr/bin/env bash
# SessionStart hook.
# - Injects ~/.claude/projects/<encoded-cwd>/RULES.md in full as always-on rules for the project.
# - Injects ~/.claude/projects/<encoded-cwd>/memory/MEMORY.md as the memory index
#   when the inject_memory_index option is on.
# Exits silently when neither file exists.

set -euo pipefail

input=""
if [[ ! -t 0 ]]; then
  input=$(cat 2>/dev/null || true)
fi

HOOK_INPUT="$input" python3 <<'PY'
import json, os, re

try:
    cwd = json.loads(os.environ["HOOK_INPUT"]).get("cwd") or ""
except Exception:
    cwd = ""
cwd = cwd or os.environ.get("PWD", "")
if not cwd:
    raise SystemExit(0)

# Same encoding Claude Code uses for project directories: every non-alphanumeric character becomes `-`.
project_dir = os.path.join(os.path.expanduser("~"), ".claude", "projects", re.sub(r"[^a-zA-Z0-9]", "-", cwd))
rules_path = os.path.join(project_dir, "RULES.md")
memory_index = ""
if os.environ.get("CLAUDE_PLUGIN_OPTION_INJECT_MEMORY_INDEX", "false") in ("true", "1", "yes", "on"):
    memory_index = os.path.join(project_dir, "memory", "MEMORY.md")

# Large enough to inject a MEMORY.md at the size memory-index-compact targets without truncation.
# Truncating here costs more than it saves: Claude reads the file again to recover the rest.
LIMIT = 18000

parts = []

if os.path.isfile(rules_path):
    with open(rules_path, encoding="utf-8") as f:
        rules = f.read()
    parts.append(
        "# Always-on rules for this project (injected by project-memory)\n"
        "# Follow these with the same priority as CLAUDE.md while working in this project.\n\n"
        + rules.rstrip() + "\n"
    )

if memory_index and os.path.isfile(memory_index):
    with open(memory_index, encoding="utf-8") as f:
        memory = f.read()
    parts.append(
        "# Memory index for this project (injected by project-memory)\n"
        "# Read individual memory files only when relevant. Do not read them all up front.\n\n"
        + memory.rstrip() + "\n"
    )

body = "\n---\n\n".join(parts)
if len(body) > LIMIT:
    body = body[:LIMIT] + "\n\n... (truncated)"

if not body:
    raise SystemExit(0)

print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": body,
    }
}, ensure_ascii=False))
PY
