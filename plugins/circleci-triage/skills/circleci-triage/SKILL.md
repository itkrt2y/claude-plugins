---
name: circleci-triage
description: Investigate failing CircleCI tests and separate flaky failures from regressions. Delegates fetching failures with the circleci CLI to a subagent to keep the main context small, then decides flaky vs regression and proposes a fix. Use for "CircleCI is failing", "CI is failing", "look into the CI failure", "why did the tests fail", "is this flaky", CI落ちてる, flakyか確認して, or /circleci-triage.
---

# CircleCI failure triage

## Steps

### 1. Prepare

Read `${CLAUDE_SKILL_DIR}/references/circleci.md` first: it covers the `circleci` CLI, authentication and naming traps.

**Check authentication in the main conversation first.** If there is no token, ask the user to set one up and stop, instead of letting a subagent get stuck on it.

### 2. Fetch the failures in a subagent

Do not fetch or read logs in the main conversation. Delegate to an `Explore` or `general-purpose` subagent with a prompt that requires:

- Follow `${CLAUDE_SKILL_DIR}/references/circleci.md`: identify the branch or PR, then fetch **only the failed tests**, starting with `circleci testresult list`.
- Return a structured list, one entry per failure: `{test file, full failure message, got/expected, rerun command}`. Never the raw log.

### 3. Decide (in the main conversation)

**Read the actual value on the "got" side.** Do not take "it's probably flaky" at face value, even from the user. A real bug that depends on execution order can pass for flakiness (for example, a missing translation key surfacing as `Translation missing`), and a strict mock can fail for an unrelated reason that the got value exposes.

- **Run the failing test locally first.** A deterministic regression fails at the same line with the same message every time.
- **The failure moves between runs** (different lines or messages) → suspect the environment or interference from concurrent runs, such as tests sharing a datastore.
- **A test that depended on the bug.** If the change fixed a silent failure, a test written against the buggy state can now break (for example, the fix makes the intended UI appear and an old selector times out). Check the history of the related tests around the commit that introduced the bug.
- **"It also fails on the base branch"** after one run is not a conclusion. If the base branch's CI is green, suspect your measurement (`gh api repos/<owner>/<repo>/commits/<sha>/check-runs`), and run several times to tell "flaky on the base" from "bug on the base".
- On a long-lived branch, also consider that an improvement merged into the base changed an assumption your tests relied on.
- If the project keeps a list of known flaky tests, check it. A failure missing from the list is more likely a regression.
- Rerunning in CI to prove flakiness is the last resort, for when local reproduction fails.

### 4. Propose a fix

- Say whether the fix targets the symptom (a brittle test) or the mechanism (a bug in the code).
- Look for the same kind of failure elsewhere. Fixing one instance can leave the next run failing on another.
