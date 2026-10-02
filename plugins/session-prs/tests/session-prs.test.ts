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
