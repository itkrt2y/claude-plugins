---
name: memory-index-compact
description: Compact the memory index (MEMORY.md) when it nears the read limit, without dropping a single link. Use when asked to "compact MEMORY.md", "the memory index is too big", "memory index compaction", MEMORY.mdを圧縮, or when a hook warns "The memory index at MEMORY.md is N KB, approaching the M KB read limit".
---

# Memory index compaction

Bring `~/.claude/projects/<encoded-cwd>/memory/MEMORY.md` under the limit. **Keep every link and its order, and shorten only the descriptions.** Never delete memory files themselves.

## First: measure the unit

Find out what the warning counts before estimating how much to cut. The warning's "KB" has been observed to be characters ÷ 1024, not bytes. Estimating in bytes overstates the cut by 1.5–2× for text that is mostly CJK.

```bash
cd <memory dir>
python3 -c "
import io
s=io.open('MEMORY.md',encoding='utf-8').read()
print(f'{len(s)} chars = {len(s)/1024:.1f}KB, {len(s.encode())} bytes, {s.count(chr(10))} lines')"
```

If a number matches the warning, convert the target with the same unit (for example 17.1KB = 17,510 characters). Claude Code's auto memory also stops loading after the first 200 lines, so keep the line count under that too. If nothing matches, find out how the warning counts before going on.

## Back up

The memory directory is often outside the sandbox's writable paths, so `cp` next to it fails. Back up to the scratchpad by absolute path.

```bash
cp <memory dir>/MEMORY.md "$SCRATCHPAD/MEMORY.md.bak"
```

## Before cutting, check the topic files

Before removing a detail from the index, confirm it exists in the topic file itself, on two or three representative files. For example, for PR numbers:

```bash
grep -o '#[0-9]\{4,\}' <topic file>.md | sort -u
```

If it is there, cut it from the index. If not, move it into the topic file first.

## What may go and what must stay

**May go:**
- Lists of PR numbers or other IDs, once confirmed in the topic file.
- A group line that strings one phrase per link together → one shared hook for the group. Link names already tell the files apart.
- Details of finished work. Keep the line and the link, shorten the description.

**Must stay:**
- **Status of unfinished work**: "not pushed", "PR not opened", "unverified", "not started" and the like (未push, PR未作成, 未検証, 未着手 in Japanese). IDs can be recovered from the topic file later, but the status is what makes anyone open the topic file. Without it, the work is forgotten.
- Warnings: "never ...", "must ...", "do not ..." (〜するな, 必須, 禁止, 不可).

**Never invert a status.** Shortening "pushed, PR not opened" to "not pushed" flips its meaning and leads the next session to push again. Compare against the backup.

## Verify (all of it, after compacting)

Set `WORDS` to the status and warning words the index actually uses, in its language.

```bash
B="$SCRATCHPAD/MEMORY.md.bak"
WORDS='not pushed,not opened,unverified,open,merged,blocked,waiting,must,never,do not,未作成,未push,未修正,未確認,未検証,マージ済,待ち,必須,禁止,不可'
# 1. Size
python3 -c "
import io
s=io.open('MEMORY.md',encoding='utf-8').read(); b=io.open('$B',encoding='utf-8').read()
print(f'{len(b)} -> {len(s)} chars ({100*(len(b)-len(s))/len(b):.0f}% cut)')"
# 2. Links identical in count and order (same order = no section moved)
diff <(grep -o '([A-Za-z0-9_.-]*\.md)' "$B") <(grep -o '([A-Za-z0-9_.-]*\.md)' MEMORY.md) && echo "links IDENTICAL"
# 3. Memory files missing from the index
for f in *.md; do [ "$f" = MEMORY.md ] || grep -qF "($f)" MEMORY.md || echo "ORPHAN: $f"; done
# 4. Links to missing files
grep -o '([A-Za-z0-9_.-]*\.md)' MEMORY.md | tr -d '()' | sort -u | while read t; do [ -f "$t" ] || echo "DANGLING: $t"; done
# 5. Status and warning words that decreased
WORDS="$WORDS" python3 - <<PY
import io, os
b=io.open("$B",encoding='utf-8').read(); s=io.open('MEMORY.md',encoding='utf-8').read()
for w in os.environ['WORDS'].split(','):
    if b.count(w) > s.count(w): print(f'decreased {w}: {b.count(w)} -> {s.count(w)}')
PY
```

**If check 5 reports a decrease, find the exact lines.** Eyeballing misses them (in one run, 5 of 11 decreases had to be restored). Lines are matched by the file name in their link.

```bash
WORDS="$WORDS" python3 - <<PY
import io, os, re
def index(path):
    d = {}
    for line in io.open(path, encoding='utf-8'):
        m = re.search(r'\(([A-Za-z0-9_.-]*\.md)\)', line)
        if m: d[m.group(1)] = line.rstrip('\n')
    return d
b, s = index("$B"), index('MEMORY.md')
words = os.environ['WORDS'].split(',')
for k in b:
    lost = [(w, b[k].count(w), s.get(k,'').count(w)) for w in words if b[k].count(w) > s.get(k,'').count(w)]
    if lost:
        print('*', k); print('  bak:', b[k][:160]); print('  now:', s.get(k,'')[:160]); print('  lost:', lost)
PY
```

Judge each hit on its own. A matching word count is not enough.

- **Technical detail or method** (present in the topic file) → leave it cut.
- **Planned, unfinished work** → restore. A note such as "X is kept until the migration finishes, then reverted" records future work and is a status.
- **Warning** → restore.
- **Paired cross-references** → keep both halves. Keeping "the former still has N places left" while cutting "the latter is merged" leaves the latter's state unreadable.

Take the space for restored text from details that check 5 judged safe to cut. The checks cannot verify what descriptions mean, so read the result once more at the end.

## Consistency with the injecting hook

When the project-memory plugin's `inject_memory_index` option is on, its SessionStart hook injects MEMORY.md and truncates it past its own limit, and Claude then reads the file again to recover the rest. Check that the compacted index fits:

```bash
echo '{"cwd":"<project cwd>"}' | CLAUDE_PLUGIN_OPTION_INJECT_MEMORY_INDEX=true bash "${CLAUDE_PLUGIN_ROOT}/hooks/load-project-memory.sh" \
  | python3 -c "
import json,sys
b=json.load(sys.stdin)['hookSpecificOutput']['additionalContext']
print(len(b), 'truncated' if b.rstrip().endswith('(truncated)') else 'full')"
```

## Report

Report the reduction, the link count and the check results. Say that the backup is in the scratchpad, which belongs to this session and will disappear.
