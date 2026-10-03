import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseGhOutput, parseMcpResult } from '../hooks/session-prs'

const SURFACES = ['terminal', 'desktop'] as const

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const PR_JSON = JSON.stringify({
  id: 1,
  url: 'https://github.com/acme/app/pull/9',
  body: 'Follows https://github.com/acme/app/pull/3',
})

function engine(on: On) {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return Box({ key: 'engine' })
  })
  on('tool.call', { tool: 'Bash' }, ($, e) => ({
    result: {
      stdout: e.command.includes('pr create') && e.command.includes('pr view')
        ? 'https://github.com/acme/app/pull/42\nurl:\thttps://github.com/acme/app/pull/42\n'
        : e.command.includes('pr create')
        ? 'https://github.com/acme/app/pull/42\n'
        : 'https://github.com/acme/app/pull/7\n',
      stderr: '',
      interrupted: false,
    },
  }))
  on('tool.call', { tool: 'mcp__github__create_pull_request' }, () => ({
    result: { content: [{ type: 'text', text: PR_JSON }], isError: false },
    text: PR_JSON,
  }))
}

describe('parsing', () => {
  test('gh output yields every PR URL', () => {
    expect(parseGhOutput('https://github.com/acme/app/pull/42\n')).toEqual([
      { url: 'https://github.com/acme/app/pull/42', repo: 'acme/app', number: 42 },
    ])
    expect(parseGhOutput('https://ghe.example.com/acme/app/pull/5\n')[0]?.repo).toBe('acme/app')
  })

  test('gh output keeps PRs created in a loop and drops PRs other gh commands print', () => {
    const stdout = [
      'https://github.com/acme/app/pull/1',
      'https://github.com/acme/app/pull/2',
      'url:\thttps://github.com/acme/app/pull/3',
      'Follows https://github.com/acme/app/pull/4',
    ].join('\n')
    expect(parseGhOutput(stdout).map(pr => pr.number)).toEqual([1, 2])
  })

  test('an MCP JSON result yields its URL field, not a PR linked in the body', () => {
    expect(parseMcpResult(PR_JSON).map(pr => pr.number)).toEqual([9])
    expect(
      parseMcpResult(
        JSON.stringify({ url: 'https://api.github.com/repos/acme/app/pulls/9', html_url: 'https://github.com/acme/app/pull/9' }),
      ).map(pr => pr.number),
    ).toEqual([9])
  })

  test('a plain-text MCP result yields its first PR URL', () => {
    expect(
      parseMcpResult('Created https://github.com/acme/app/pull/9 (see https://github.com/acme/app/pull/3)').map(pr => pr.number),
    ).toEqual([9])
  })
})

test('the band stays hidden until a PR is created', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: 'Bash', command: 'gh pr view 7' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'session-prs', surface, ...BAND })
    expect(await ui.find({ key: 'hide' })).toBeUndefined()
    await ui.unmount()
  }
})

test('PRs created with gh and through MCP are listed once each', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --title x --body y' })
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --title x --body y' })
  await $.tool.call({ tool: 'mcp__github__create_pull_request', owner: 'acme', repo: 'app' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'session-prs', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /\(2\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: 'acme/app#42' })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: 'acme/app#9' })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: 'acme/app#3' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a PR URL printed twice in one command is listed once', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill && gh pr view' })

  const ui = await $.ui.mount({ plugin: 'session-prs', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /\(1\)/ })).toBeDefined()
  await ui.unmount()
})

test('Hide removes the band', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })

  const ui = await $.ui.mount({ plugin: 'session-prs', surface: 'terminal', ...BAND })
  await ui.press({ key: 'hide' })
  expect(await ui.find({ key: 'hide' })).toBeUndefined()
  await ui.unmount()
})

const use = (tool: string, input: Record<string, unknown>, result: unknown, text?: string) => ({
  tool_use_id: `${tool}-${JSON.stringify(input)}`,
  tool,
  input,
  result,
  text,
})

test('PRs already in the transcript are listed at session start', async ($, on) => {
  engine(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.messages', () => ({ value: [
    {
      role: 'assistant',
      text: '',
      toolUses: [
        use('Bash', { command: 'gh pr create --fill' }, { stdout: 'https://github.com/acme/app/pull/42\n', stderr: '', interrupted: false }),
        use('Bash', { command: 'gh pr view 7' }, { stdout: 'https://github.com/acme/app/pull/7\n', stderr: '', interrupted: false }),
        use('mcp__github__create_pull_request', { owner: 'acme' }, undefined, PR_JSON),
        { ...use('Bash', { command: 'gh pr create' }, undefined, 'https://github.com/acme/app/pull/5'), isError: true as const },
      ],
    },
  ] }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'session-prs', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /\(2\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: 'acme/app#42' })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: 'acme/app#9' })).toBeDefined()
    await ui.unmount()
  }
})

const ran = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

const GH_LIST = JSON.stringify([
  { number: 42, state: 'OPEN', title: 'Add the thing', reviewDecision: 'CHANGES_REQUESTED' },
  { number: 9, state: 'MERGED', title: 'Fix the other thing', reviewDecision: 'APPROVED' },
  { number: 50, state: 'OPEN', title: 'Made in the browser', reviewDecision: '' },
  { number: 3, state: 'CLOSED', title: 'Abandoned', reviewDecision: '' },
])

const OLD_PR = JSON.stringify({ number: 1, state: 'MERGED', title: 'Too old to be listed', reviewDecision: '' })

// gh lists acme/app only and views acme/app#1 only; any other repo fails. The store starts with `index`.
function session(on: On, id: string, index?: unknown[]) {
  const store = new Map<string, unknown>(index ? [['index', index]] : [])
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.id', () => ({ value: id }))
  on('session.cwd', () => ({ value: `/work/${id}` }))
  on('process.run', ($, e) =>
    e.argv[0] === 'git'
      ? ran(`branch-${id}\n`)
      : e.argv.includes('github.com/acme/app')
      ? ran(GH_LIST)
      : e.argv.includes('https://github.com/acme/app/pull/1')
      ? ran(OLD_PR)
      : ran('', 1),
  )
}

const prSessions = (args: string) => ({
  command: 'pr-sessions',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})

const indexed = (repo: string, number: number, sessionId: string) => ({
  url: `https://github.com/${repo}/pull/${number}`,
  repo,
  number,
  sessionId,
  cwd: `/work/${sessionId}`,
  branch: null,
  recordedAt: '2026-01-01T00:00:00.000Z',
})

test('created PRs are indexed with the session that created them', async ($, on) => {
  engine(on)
  session(on, 'first')
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
  await $.tool.call({ tool: 'mcp__github__create_pull_request', owner: 'acme', repo: 'app' })

  const { text } = await $.command.run(prSessions(''))
  expect(text).toContain('Open (1)')
  expect(text).toContain('acme/app#42 [CHANGES_REQUESTED] Add the thing')
  expect(text).toContain('claude --resume first')
  expect(text).toContain('/work/first (branch-first)')
  expect(text).toContain('Merged or closed (1)')
  expect(text).toContain('acme/app#9 [MERGED] /work/first')
})

test('open PRs with no recorded session point at --from-pr', async ($, on) => {
  engine(on)
  session(on, 'first')
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })

  const { text } = await $.command.run(prSessions(''))
  expect(text).toContain('Open, no recorded session (1)')
  expect(text).toContain('acme/app#50 Made in the browser')
  expect(text).toContain('claude --from-pr 50')
  expect(text).not.toContain('#3 ')
})

test('a PR keeps the session that recorded it first', async ($, on) => {
  engine(on)
  session(on, 'second', [indexed('acme/app', 42, 'first')])
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })

  const { text } = await $.command.run(prSessions(''))
  expect(text).toContain('claude --resume first')
  expect(text).not.toContain('claude --resume second')
})

test('prune drops merged and closed PRs and keeps PRs gh could not list', async ($, on) => {
  engine(on)
  session(on, 'first', [indexed('acme/app', 42, 'a'), indexed('acme/app', 9, 'b'), indexed('acme/other', 1, 'c')])

  expect((await $.command.run(prSessions('prune'))).text).toContain('dropped 1')
  const { text } = await $.command.run(prSessions(''))
  expect(text).toContain('Open (2)')
  expect(text).toContain('acme/other#1 [unknown]')
  expect(text).not.toContain('acme/app#9 ')
})

test('an indexed PR older than the listed ones is looked up on its own', async ($, on) => {
  engine(on)
  session(on, 'first', [indexed('acme/app', 1, 'a')])

  const { text } = await $.command.run(prSessions(''))
  expect(text).toContain('acme/app#1 [MERGED] /work/a')
})

test('the list says when nothing is recorded', async ($, on) => {
  engine(on)
  session(on, 'first')
  expect((await $.command.run(prSessions(''))).text).toBe('pr-sessions: no PRs recorded yet')
})
