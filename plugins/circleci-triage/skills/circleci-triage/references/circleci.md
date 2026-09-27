# Debugging CircleCI

Use the `circleci` CLI. If a command behaves differently from what is described here, check `circleci version` and the subcommand's help first.

## Check authentication; stop if it fails

```bash
circleci auth me
```

When the token lives in the OS keyring (`circleci setting list` shows `Keyring: true`), the sandbox cannot read it and the CLI reports `No CircleCI API token found`. Run it with the sandbox disabled, or provide `CIRCLE_TOKEN` through the environment.

If there is no token at all, **ask the user and stop**; do not log in yourself. Suggest running `! circleci auth login` or setting `CIRCLE_TOKEN`.

- Outside the repository, the project cannot be inferred from the git remote: pass `--project gh/owner/repo`.
- With `--project` and no branch, the CLI **falls back to main**: always pass `-b <branch>`.
- `run get` without a run opens an interactive picker: add `--no-interactive` (`run list` has no such flag).

## Starting from a web URL

`https://app.circleci.com/pipelines/github/<owner>/<repo>/<pipeline-number>/workflows/<workflow-id>/jobs/<job-number>` ends in a **job number**, but the CLI wants a job UUID, and job numbers do not appear in CLI output. Find the job in the workflow by name or outcome:

```bash
circleci workflow get <workflow-id> --json --jq '.jobs[]'
```

## Getting failure details (in this order)

**1. Structured test results (first choice)**

```bash
circleci run get --project gh/owner/repo -b <branch> --no-interactive --json --jq '.workflows[].id'
circleci workflow get <workflow-id> --json --jq '.jobs[] | select(.outcome == "failed")'
circleci testresult list <job-id> --json > <scratchpad>/tests.jsonl   # failures only by default
```

Observed job `outcome` values: `succeeded`, `failed`, `not_run`. `workflow get --jq` runs once on the whole object, so `select()` works.

`testresult list --json` prints JSONL, one record per line, with `classname`, `name`, `result`, `run_time` and `message`. `message` includes the stack trace and, for RSpec, the rerun command, which is usually enough to triage. `--jq` runs per record; aggregate with `jq -s`. Filter with `--filter classname=<substr>` or `--filter result=skipped`; `--all` returns every result.

Write output to an absolute scratchpad path: with the sandbox disabled, `$TMPDIR` may not be set.

For jobs with parallelism, check the executions with `circleci job get <job-id> --json | jq '[.executions[].index]'`.

**2. Failed steps (for failures outside tests)**

```bash
circleci run get <run-id> --failure-report
circleci job get <job-id> --json | jq '[.executions[].steps[] | select(.exit_code != null and .exit_code != 0) | {num, name, exit_code}]'
```

`--failure-report` gives condensed output per failed step. It cannot show test failures when the tests run on a remote executor outside CircleCI: the step output then holds only orchestration logs. Use it for jobs that failed to start and for environment or build errors.

**3. Raw logs (last resort)**

```bash
circleci job output list <job-id> --json | jq '.steps[] | select(.exit_code != 0)'
circleci job output get <job-id> --step-num <n> --condensed
```

`--condensed` (experimental) keeps only error-related lines, filtered on the server. Without it, output is large and easily truncated. For parallel jobs, add `--execution <index>`.

## Check names

`gh pr checks <number>` shows the latest commit's status, but CircleCI check names can mislead: a hash in a check name such as `<workflow-name> - 771f63a7` comes from the **workflow ID**, not the commit SHA, and old workflows' check names can linger on new commits.

To see the checks of a specific commit:

```bash
gh api repos/<owner>/<repo>/commits/<sha>/check-runs --jq '.check_runs[] | {name, status, conclusion}'
```

## Rerunning

- Failed jobs only: `circleci workflow rerun <workflow-id> --from-failed` (creates a new workflow and returns its `workflow_id`).
- All jobs from the start: drop `--from-failed`.
- On a new commit: pushing triggers CircleCI.

## Common misreadings

- **"CI is running on an old commit"**: if the PR's head is the new commit, CI runs on it. Confirm with `gh pr view <number> --json headRefOid`; do not go by the hash in the check name.
- **A check named after a workflow** aggregates all jobs in it. Follow the per-job links in its `output.summary`.
