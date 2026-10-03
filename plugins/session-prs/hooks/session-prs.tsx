import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CreatedPr, IndexedPr, SessionPrs } from '../types'

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

const addNew = <T extends CreatedPr>(known: readonly T[], found: readonly CreatedPr[], toEntry: (pr: CreatedPr) => T) =>
  found.reduce((acc, pr) => (acc.some(k => k.url === pr.url) ? acc : [...acc, toEntry(pr)]), known as T[])

// The index of every recorded PR lives in the plugin's store, which every session shares.
const INDEX_KEY = 'index'

const readIndex = async ($: EngineInterface): Promise<IndexedPr[]> => {
  const value = await $.store.get(INDEX_KEY)
  return Array.isArray(value) ? (value as IndexedPr[]) : []
}

const currentBranch = async ($: EngineInterface, cwd: string) => {
  try {
    const ran = await $.process.run(['git', 'branch', '--show-current'], { cwd })
    return ran.exitCode === 0 ? ran.stdout.trim() || null : null
  } catch {
    return null
  }
}

// A PR keeps the session that recorded it first.
const addToIndex = async ($: EngineInterface, found: CreatedPr[]) => {
  const index = await readIndex($)
  if (found.every(pr => index.some(known => known.url === pr.url))) {
    return
  }
  const sessionId = await $.session.id()
  const cwd = await $.session.cwd()
  const branch = await currentBranch($, cwd)
  const recordedAt = new Date().toISOString()
  await $.store.set(INDEX_KEY, addNew(index, found, pr => ({ ...pr, sessionId, cwd, branch, recordedAt })))
}

// A PR created now shows the band again; PRs found in the transcript keep it as it is.
const record = async ($: EngineInterface, found: CreatedPr[], reveal: boolean) => {
  if (found.length === 0) {
    return
  }
  await update($, band, state => {
    const prs = addNew(state.prs, found, pr => pr)
    const isHidden = reveal ? false : state.isHidden
    return prs === state.prs && isHidden === state.isHidden ? state : { prs, isHidden }
  })
  await addToIndex($, found)
}

export type GhPr = { number: number; state: string; title: string; reviewDecision: string }

const HOST = /^https:\/\/([^/]+)\//

// `host/owner/name`, the form `gh --repo` takes for any host.
const repoKey = (pr: CreatedPr) => `${HOST.exec(pr.url)?.[1] ?? 'github.com'}/${pr.repo}`

const GH_FIELDS = 'number,state,title,reviewDecision'

const runGh = async <T,>($: EngineInterface, argv: string[]): Promise<T | undefined> => {
  try {
    const ran = await $.process.run(['gh', ...argv, '--json', GH_FIELDS])
    return ran.exitCode === 0 ? (JSON.parse(ran.stdout) as T) : undefined
  } catch {
    return undefined
  }
}

// The author's recent PRs in each repo the index mentions, plus any indexed PR older than
// those; a repo gh could not list maps to undefined.
const fetchGhPrs = async ($: EngineInterface, index: readonly IndexedPr[]) => {
  const byRepo = new Map<string, GhPr[] | undefined>()
  for (const key of new Set(index.map(repoKey))) {
    byRepo.set(key, await runGh<GhPr[]>($, ['pr', 'list', '--repo', key, '--author', '@me', '--state', 'all', '--limit', '500']))
  }
  for (const pr of index) {
    const listed = byRepo.get(repoKey(pr))
    if (listed !== undefined && !listed.some(gh => gh.number === pr.number)) {
      const viewed = await runGh<GhPr>($, ['pr', 'view', pr.url])
      if (viewed !== undefined) {
        listed.push(viewed)
      }
    }
  }
  return byRepo
}

const ghPrOf = (byRepo: ReadonlyMap<string, GhPr[] | undefined>, pr: CreatedPr) =>
  byRepo.get(repoKey(pr))?.find(gh => gh.number === pr.number)

const isDone = (gh: GhPr | undefined) => gh?.state === 'MERGED' || gh?.state === 'CLOSED'

const clip = (text: string, max = 60) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export const formatIndex = (index: readonly IndexedPr[], byRepo: ReadonlyMap<string, GhPr[] | undefined>) => {
  if (index.length === 0) {
    return 'session-prs: no PRs recorded yet'
  }
  const lines: string[] = []
  const open = index.filter(pr => !isDone(ghPrOf(byRepo, pr)))
  const done = index.filter(pr => isDone(ghPrOf(byRepo, pr)))

  lines.push(`Open (${open.length})`)
  for (const pr of open) {
    const gh = ghPrOf(byRepo, pr)
    const status = gh === undefined ? 'unknown' : gh.reviewDecision || gh.state
    lines.push(`  ${pr.repo}#${pr.number} [${status}] ${clip(gh?.title ?? '')}`.trimEnd())
    lines.push(`    claude --resume ${pr.sessionId}`)
    lines.push(`    ${pr.cwd}${pr.branch ? ` (${pr.branch})` : ''}`)
  }

  const unrecorded = [...byRepo].flatMap(([key, prs]) =>
    (prs ?? [])
      .filter(gh => gh.state === 'OPEN' && !index.some(pr => repoKey(pr) === key && pr.number === gh.number))
      .map(gh => ({ repo: key.split('/').slice(1).join('/'), gh })),
  )
  if (unrecorded.length > 0) {
    lines.push('', `Open, no recorded session (${unrecorded.length})`)
    for (const { repo, gh } of unrecorded) {
      lines.push(`  ${repo}#${gh.number} ${clip(gh.title)}`, `    claude --from-pr ${gh.number}`)
    }
  }

  if (done.length > 0) {
    lines.push('', `Merged or closed (${done.length}); /session-prs prune drops them`)
    for (const pr of done) {
      lines.push(`  ${pr.repo}#${pr.number} [${ghPrOf(byRepo, pr)?.state}] ${pr.cwd}`)
    }
  }
  return lines.join('\n')
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
      description:
        'Show or hide the PRs created in this session; `list` lists every recorded PR with its session, `prune` drops merged and closed ones',
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

  on('command.run', { command: 'session-prs' }, async ($, e) => {
    const action = e.args.trim()
    if (action === '') {
      const { isHidden } = await update($, band, state => ({ ...state, isHidden: !state.isHidden }))
      return { text: isHidden ? 'session-prs: hidden' : 'session-prs: shown' }
    }
    if (action !== 'list' && action !== 'prune') {
      return { text: 'session-prs: usage: /session-prs [list|prune]' }
    }

    const index = await readIndex($)
    const byRepo = await fetchGhPrs($, index)
    if (action === 'prune') {
      const kept = index.filter(pr => !isDone(ghPrOf(byRepo, pr)))
      await $.store.set(INDEX_KEY, kept)
      return { text: `session-prs: dropped ${index.length - kept.length} merged or closed PRs` }
    }
    return { text: formatIndex(index, byRepo) }
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
