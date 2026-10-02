import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { CreatedPr, SessionPrs } from '../types'

const band = atom({ plugin: 'session-prs', key: 'band' } as const, {
  prs: [],
  isHidden: false,
} as SessionPrs)

const GH_PR_CREATE = /\bgh\s+pr\s+create\b/
// Any MCP server's PR creation tool, e.g. the GitHub MCP server's create_pull_request.
const MCP_PR_CREATE = /^mcp__.+__create_pull_request$/
const PR_URL = /https:\/\/[\w.-]+(?::\d+)?\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\b/
const PR_URL_EXACT = new RegExp(`^${PR_URL.source}$`)

const fromMatch = (m: RegExpExecArray | null): CreatedPr | undefined =>
  m ? { url: m[0], repo: m[1] ?? '', number: Number(m[2]) } : undefined

// gh pr create prints each created PR's URL on a line of its own, so a chained
// `gh pr view` (`url:\t<URL>`) or `gh pr list` does not add PRs it only shows.
export const parseGhOutput = (stdout: string): CreatedPr[] =>
  stdout.split('\n').flatMap(line => fromMatch(PR_URL_EXACT.exec(line.trim())) ?? [])

// The result echoes the PR body, which may link other PRs, so a JSON result's URL
// field wins, and plain text yields only its first PR URL.
export const parseMcpResult = (text: string): CreatedPr[] => {
  try {
    const json: unknown = JSON.parse(text)
    if (typeof json === 'object' && json !== null) {
      for (const key of ['html_url', 'url']) {
        const value = (json as Record<string, unknown>)[key]
        const pr = typeof value === 'string' ? fromMatch(PR_URL_EXACT.exec(value)) : undefined
        if (pr) {
          return [pr]
        }
      }
    }
  } catch {}

  const pr = fromMatch(PR_URL.exec(text))
  return pr ? [pr] : []
}

const recordAfter = async <R extends ToolCallResult>(
  $: EngineInterface,
  ran: R,
  parse: (ran: Exclude<R, { deny: string } | { isError: true }>) => CreatedPr[],
): Promise<R> => {
  if (ran.deny !== undefined || ran.isError) {
    return ran
  }
  const found = parse(ran as Exclude<R, { deny: string } | { isError: true }>)
  if (found.length > 0) {
    await update($, band, state => {
      const prs = found.reduce(
        (acc, pr) => (acc.some(known => known.url === pr.url) ? acc : [...acc, pr]),
        state.prs,
      )
      return prs === state.prs && !state.isHidden ? state : { prs, isHidden: false }
    })
  }
  return ran
}

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    return GH_PR_CREATE.test(e.command)
      ? recordAfter($, ran, ok => parseGhOutput(ok.result.stdout))
      : ran
  })

  on('tool.call', { tool: MCP_PR_CREATE }, async ($, e, next) =>
    recordAfter($, await next(e), ok => parseMcpResult(ok.text ?? '')),
  )

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'session-prs',
      description: 'Show or hide the pull requests created in this session',
    })
    return next(e)
  })

  on('command.run', { command: 'session-prs' }, async $ => {
    const { isHidden } = await update($, band, state => ({ ...state, isHidden: !state.isHidden }))
    return { text: isHidden ? 'session-prs: hidden' : 'session-prs: shown' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { prs, isHidden } = await read($, band)
    if (e.props.hasSurvey || prs.length === 0 || isHidden) {
      return next(e)
    }

    const { Box, Button, Link, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>PRs this session ({prs.length}) </Text>
          <Button
            key="hide"
            label="Hide"
            onPress={() => update($, band, state => ({ ...state, isHidden: true }))}
          />
        </Box>
        {prs.map(pr => (
          <Box key={pr.url}>
            <Text>• </Text>
            <Link href={pr.url} label={`${pr.repo}#${pr.number}`} />
          </Box>
        ))}
      </Box>
    )
  })
}
