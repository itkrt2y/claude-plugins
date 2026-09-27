#!/usr/bin/env bash
# Notification hook: show a desktop notification that says which session it came from.
# Title: the session name set with /rename, else the git branch, else the directory name.
# Targets a local GNOME session. Requires notify-send (libnotify), jq and GNU coreutils (tac, timeout).
# Plays a sound with canberra-gtk-play when it is installed.

input=$(timeout 2 cat)

{
  IFS= read -r cwd
  IFS= read -r session_id
  IFS= read -r transcript
  IFS= read -r message
} < <(printf '%s' "$input" | jq -r '.cwd, .session_id, .transcript_path, .message | . // "" | gsub("\n"; " ")')

# A name given with /rename is stored in the transcript as a custom-title record.
if [ ! -f "$transcript" ] && [ -n "$session_id" ]; then
  transcript=$(ls -1 "$HOME"/.claude/projects/*/"$session_id".jsonl 2>/dev/null | head -1)
fi
session_name=""
if [ -f "$transcript" ]; then
  session_name=$(tac "$transcript" | grep -m1 '"type":"custom-title"' | jq -r '.customTitle // empty')
fi

location=$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null)
[ -z "$location" ] && location=$(basename "${cwd:-$PWD}")

title="${session_name:-$location}"
body="${message:-Done}"
[ -n "$session_name" ] && body="$body"$'\n'"$location"

notify-send -a 'Claude Code' "$title" "$body"
if command -v canberra-gtk-play >/dev/null 2>&1; then
  canberra-gtk-play -i message-new-instant -V 10
fi
exit 0
