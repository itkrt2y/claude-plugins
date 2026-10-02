import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

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

// The PRs one successful tool call created, from its input and its result.
export const prsFromToolUse = (
  tool: string,
  input: Record<string, unknown>,
  result: unknown,
  text: string | undefined,
): CreatedPr[] => {
  if (tool === 'Bash') {
    const stdout = (result as { stdout?: unknown } | undefined)?.stdout
    return typeof input.command === 'string' && GH_PR_CREATE.test(input.command) && typeof stdout === 'string'
      ? parseGhOutput(stdout)
      : []
  }
  return MCP_PR_CREATE.test(tool) && text !== undefined ? parseMcpResult(text) : []
}

// A PR created now shows the band again; PRs found in the transcript keep it as it is.
const record = async ($: EngineInterface, found: CreatedPr[], reveal: boolean) => {
  if (found.length === 0) {
    return
  }
  await update($, band, state => {
    const prs = found.reduce(
      (acc, pr) => (acc.some(known => known.url === pr.url) ? acc : [...acc, pr]),
      state.prs,
    )
    const isHidden = reveal ? false : state.isHidden
    return prs === state.prs && isHidden === state.isHidden ? state : { prs, isHidden }
  })
}

// Picks up PRs created before the plugin loaded, such as earlier in a resumed session.
const scanTranscript = async ($: EngineInterface) => {
  const found = (await $.session.messages()).flatMap(message =>
    message.toolUses.flatMap(use =>
      use.isError ? [] : prsFromToolUse(use.tool, use.input, use.result, use.text),
    ),
  )
  await record($, found, false)
}

export const register: Register = on => {
  let hasScanned = false

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) {
      await record($, prsFromToolUse(e.tool, e, ran.result, ran.text), true)
    }
    return ran
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'session-prs',
      description: 'Show or hide the pull requests created in this session',
    })
    await scanTranscript($)
    return next(e)
  })

  // A resumed transcript may not be readable yet at session.start, so scan once more.
  on('prompt.submit', async ($, e, next) => {
    if (!hasScanned) {
      hasScanned = true
      await scanTranscript($)
    }
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
