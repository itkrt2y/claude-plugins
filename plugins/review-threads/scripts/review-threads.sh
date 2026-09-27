#!/usr/bin/env bash
# List, reply to, resolve and edit GitHub pull request review threads with gh.
#
# Usage:
#   review-threads.sh [-R OWNER/REPO] list [PR] [--all]
#   review-threads.sh [-R OWNER/REPO] reply THREAD_ID          < body
#   review-threads.sh [-R OWNER/REPO] resolve THREAD_ID...
#   review-threads.sh [-R OWNER/REPO] unresolve THREAD_ID...
#   review-threads.sh [-R OWNER/REPO] edit COMMENT_ID          < body
#
# PR defaults to the pull request of the current branch.
# THREAD_ID is the thread node ID (PRRT_...) printed by `list`.
# COMMENT_ID is the numeric `databaseId` of a comment printed by `list`.
# Bodies are read from stdin verbatim, so Markdown needs no shell escaping.

set -euo pipefail

usage() {
  sed -n '4,9p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

repo=""
if [[ "${1:-}" == "-R" ]]; then
  [[ $# -ge 2 ]] || usage
  repo="$2"
  shift 2
fi
[[ $# -ge 1 ]] || usage
cmd="$1"
shift

owner_and_name() {
  if [[ -n "$repo" ]]; then
    printf '%s\n%s\n' "${repo%%/*}" "${repo#*/}"
  else
    gh repo view --json owner,name --jq '.owner.login, .name'
  fi
}

read_body() {
  local body
  body=$(cat)
  if [[ -z "${body//[[:space:]]/}" ]]; then
    echo "review-threads: empty body on stdin" >&2
    exit 2
  fi
  printf '%s' "$body"
}

case "$cmd" in
  list)
    pr=""
    all=false
    for arg in "$@"; do
      case "$arg" in
        --all) all=true ;;
        *) pr="$arg" ;;
      esac
    done
    if [[ -z "$pr" ]]; then
      if [[ -n "$repo" ]]; then
        echo "review-threads: PR number is required with -R" >&2
        exit 2
      fi
      pr=$(gh pr view --json number --jq .number)
    fi
    { read -r owner; read -r name; } < <(owner_and_name)

    gh api graphql --paginate --slurp \
      -f owner="$owner" -f name="$name" -F number="$pr" \
      -f query='
        query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              reviewThreads(first: 100, after: $endCursor) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id
                  isResolved
                  isOutdated
                  path
                  line
                  originalLine
                  comments(first: 100) {
                    nodes { databaseId author { login } createdAt url body }
                  }
                }
              }
            }
          }
        }' |
      jq --argjson all "$all" '
        [ .[].data.repository.pullRequest.reviewThreads.nodes[]
          | select($all or (.isResolved | not))
          | {
              thread_id: .id,
              resolved: .isResolved,
              outdated: .isOutdated,
              path,
              line: (.line // .originalLine),
              comments: [ .comments.nodes[]
                | { id: .databaseId, author: .author.login, created_at: .createdAt, url, body } ]
            } ]'
    ;;

  reply)
    [[ $# -eq 1 ]] || usage
    body=$(read_body)
    gh api graphql -F threadId="$1" -f body="$body" -f query='
      mutation($threadId: ID!, $body: String!) {
        addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
          comment { databaseId url }
        }
      }' --jq '.data.addPullRequestReviewThreadReply.comment'
    ;;

  resolve | unresolve)
    [[ $# -ge 1 ]] || usage
    mutation="${cmd}ReviewThread"
    for thread_id in "$@"; do
      gh api graphql -F threadId="$thread_id" -f query="
        mutation(\$threadId: ID!) {
          $mutation(input: { threadId: \$threadId }) {
            thread { id isResolved }
          }
        }" --jq ".data.$mutation.thread"
    done
    ;;

  edit)
    [[ $# -eq 1 ]] || usage
    body=$(read_body)
    { read -r owner; read -r name; } < <(owner_and_name)
    # PATCH does not notify reviewers, unlike posting a new reply.
    gh api -X PATCH "repos/$owner/$name/pulls/comments/$1" -f body="$body" --jq '{id, url: .html_url}'
    ;;

  *)
    usage
    ;;
esac
