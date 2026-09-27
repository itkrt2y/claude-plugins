---
name: respond-reviews
description: Respond to GitHub pull request review comments from bots and humans. Fetches unresolved review threads, verifies each comment, fixes code or replies, then resolves the thread. Use for "respond to the review", "address the Copilot comments", "handle unresolved threads", "reply to PR comments", レビュー指摘対応して, 未resolveのthread対応して, or /respond-reviews [PR number].
---

# Respond to PR review threads

All GitHub calls go through `${CLAUDE_PLUGIN_ROOT}/scripts/review-threads.sh`. Do not hand-write GraphQL queries for threads.

```sh
S="${CLAUDE_PLUGIN_ROOT}/scripts/review-threads.sh"
"$S" list [PR]                 # unresolved threads as JSON (add --all to include resolved)
"$S" reply PRRT_xxx <<'EOF'    # reply inside the thread
Body in Markdown.
EOF
"$S" resolve PRRT_xxx [...]    # resolve one or more threads
"$S" edit 123456789 <<'EOF'    # rewrite a posted comment (no notification)
New body.
EOF
```

Add `-R OWNER/REPO` before the subcommand when the working directory is not the PR's repository; `list` then needs the PR number. `thread_id` is the thread node ID and `comments[].id` is the numeric comment ID; they are not interchangeable.

## Steps

### 1. Fetch unresolved threads

Run `list`. The PR defaults to the current branch's PR; use the argument when one is given. Handle unresolved threads only. Outdated threads (`outdated: true`) usually point at code that has already changed, so check whether the comment still applies before acting on it.

### 2. Verify each comment before acting

- Check the claim against the production code path, not only the file the reviewer quoted. A reviewer (especially a bot) may generalize from a test helper or fixture.
- Before fixing the comment literally, ask whether the design itself is the problem. "A is buggy" often resolves to "A is unnecessary". Consider a removal before an addition.
- Several reviewers flagging the same line proves it is easy to spot, not that it is in scope. Judge each comment by whether it is inside the diff's intent.
- For a false positive, ask why the reviewer was misled. It often points at a naming or structure problem worth fixing.

### 3. Decide per thread

- **Valid** → fix the code. Reply with what changed, then resolve.
- **Valid but out of scope** → do not grow the PR. Reply that it will be handled separately, and tell the user so they can track it.
- **Partly valid (trade-off)** → reply with the current decision, the reason, and the condition that would change it.
- **Misunderstanding or already handled** → reply pointing at the code or commit that handles it.
- **Trivial (typo, etc.)** → fix silently and resolve without a reply.

### 4. Commit

Follow the repository's and the user's conventions on amending versus adding commits. Do not push unless the user asked for it.

### 5. Reply, then resolve

Write replies in the language the reviewer used, unless the user says otherwise.

- **Bots (Copilot, Gemini Code Assist, etc.)**: start with the fact or the action ("Fixed in ...", "This is intended because ..."). No thanks or greetings.
- **Humans**: keep the usual courtesy.
- One paragraph per line. Do not hard-wrap at a column; GitHub renders single newlines as line breaks.
- Bodies come from a quoted heredoc (`<<'EOF'`), so write `` ` ``, `"` and `!` as they are. A backslash would be posted literally.
- Write commit SHAs and PR numbers (`#123`) bare, with a space on both sides. Inside backticks, or directly next to non-word characters such as CJK text or punctuation, GitHub does not autolink them.
- A SHA in a reply goes stale after an amend and force-push. While the PR is a draft, prefer a relative phrase ("in the next commit"). Once review is underway, `edit` the reply to the new SHA after rewriting history.
- State facts and stop. Do not offer extra work ("Happy to also ...", "Let me know if ..."). It widens the PR's scope.

Resolve every thread you handled, including the ones fixed silently.

### 6. Report

Summarize per thread: what was decided, what changed, and which threads were left open and why.
