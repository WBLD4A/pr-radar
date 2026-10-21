import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'

import { ME, rawPr, search } from './fixtures'

const JIRA_SEARCH = 'mcp__atlassian__searchJiraIssuesUsingJql'
const JIRA_SITES = 'mcp__atlassian__getAccessibleAtlassianResources'
const SESSIONS = 'mcp__ccd_session_mgmt__list_sessions'
const START = 'mcp__ccd_session_mgmt__start_session'
const TERMINAL = 'mcp__terminal__run_in_terminal'
const SEND = 'mcp__ccd_session_mgmt__send_message'

const PANE = {
  plugin: 'pr-radar',
  component: 'Pane',
  requestId: 'pr-radar',
  props: {
    title: 'PR Radar',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

type Launched = { tool: string; input: Record<string, unknown> }

type GitHub = { failure?: string; remaining?: number; resetAt?: string; resetEpoch?: number; queries: string[] }

type Access = { asks: string[]; deny?: string; first: string[]; read: Launched[]; jiraAnswer?: string }

const NOW = Date.parse('2026-10-13T12:00:00Z')

const host = (
  on: On,
  launchers: string[] = [START],
  readyExit: number | 'deny' = 0,
  store: Record<string, unknown> = {},
): {
  prompts: string[]
  launched: Launched[]
  copied: string[]
  readied: string[][]
  toasts: string[]
  github: GitHub
  access: Access
  clock: MockClock
} => {
  const github: GitHub = { queries: [] }
  const access: Access = { asks: [], first: [], read: [] }
  const prompts: string[] = []
  const readied: string[][] = []
  const toasts: string[] = []
  const copied: string[] = []
  const launched: Launched[] = []
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, store)
  mock.env(on, { USERPROFILE: 'C:/Users/me', CLAUDE_CODE_EXECPATH: 'C:/bin/claude.exe' })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  on('ui.copy', (_, e) => {
    copied.push(e.text)
    return { value: undefined } as never
  })
  const data = search({
    authored: [
      rawPr({ number: 1, title: 'ABC-1 broken build', ci: 'FAILURE' }),
      rawPr({ number: 2, title: 'ABC-2 approved', labels: ['approved'] }),
      rawPr({ number: 6, title: 'needs follow-up', labels: ['request-changes'] }),
      rawPr({ number: 3, title: 'draft work', isDraft: true }),
      rawPr({ number: 5, title: 'ABC-5 parked', ci: 'FAILURE' }),
    ],
    requested: [rawPr({ number: 4, title: 'their change', author: 'bob', requested: [ME] })],
  })
  on('process.run', (_, e) => {
    const [command] = e.argv
    if (command === 'gh' && e.argv[1] === 'pr') {
      readied.push([...e.argv])
      if (readyExit === 'deny') return { deny: 'gh not found' }
      return { value: { exitCode: readyExit, stdout: '', stderr: readyExit === 0 ? '' : 'GraphQL: Resource not accessible', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (command === 'gh' && e.argv[2] === 'user') return { value: { exitCode: 0, stdout: `${ME}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (command === 'gh' && e.argv[2] === 'rate_limit') {
      return { value: { exitCode: 0, stdout: `${github.resetEpoch ?? 0}
`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (command === 'gh') {
      const isDetail = e.argv.some(arg => arg.includes('nodes(ids'))
      github.queries.push(isDetail ? 'details' : 'ids')
      if (github.failure !== undefined) {
        return { value: { exitCode: 1, stdout: '', stderr: github.failure, isStdoutTruncated: false, isStderrTruncated: false } }
      }
      const roles = ['authored', 'requested', 'reviewed', 'assigned'] as const
      const answer = isDetail
        ? {
            rateLimit: { remaining: github.remaining ?? 4000, resetAt: github.resetAt ?? '2026-10-13T12:30:00Z' },
            nodes: e.argv
              .filter(arg => arg.startsWith('ids[]='))
              .map(arg => roles.flatMap(role => data[role].nodes).find(pr => pr.id === arg.slice(6)) ?? null),
          }
        : { viewer: data.viewer, ...Object.fromEntries(roles.map(role => [role, { nodes: data[role].nodes.map(pr => ({ id: pr.id })) }])) }
      return { value: { exitCode: 0, stdout: JSON.stringify({ data: answer }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (command === 'python' && e.argv.some(arg => arg.endsWith('checkouts.py'))) {
      return { value: { exitCode: 0, stdout: JSON.stringify({ 'acme/app': 'C:/src/app' }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (command === 'python') {
      const runs = [
        { runId: 'r1', repo: 'acme/app', pr: 2, jiraKey: null, branch: null, workflow: 'review-follow-up', status: 'partial', startedAt: '2026-10-12T10:00:00Z', client: 'claude-desktop', sessionId: null },
        { runId: 'r2', repo: 'acme/tools', pr: null, jiraKey: 'ABC-7', branch: 'ABC-7-x', workflow: 'bug-fixer', status: 'local-uncommitted', startedAt: '2026-10-12T10:00:00Z', client: 'codex', sessionId: null },
      ]
      return { value: { exitCode: 0, stdout: JSON.stringify(runs), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (command === 'git') return { value: { exitCode: 0, stdout: 'https://github.com/acme/app.git\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 1, stdout: '', stderr: 'unknown', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.list', () => ({
    value: [
      ...access.first.map(name => ({ name, description: '', mcp: true })),
      { name: JIRA_SEARCH, description: '', mcp: true },
      { name: JIRA_SITES, description: '', mcp: true },
      { name: SESSIONS, description: '', mcp: true },
      ...launchers.map(name => ({ name, description: '', mcp: true })),
    ],
  }))
  on('tool.check', (_, e) => ({ decision: access.asks.includes(e.tool) ? 'ask' : 'allow' }))
  on('tool.call', (_, e) => {
    if (e.tool === JIRA_SITES || e.tool === JIRA_SEARCH || e.tool === SESSIONS || access.first.includes(e.tool)) {
      const { tool, ...input } = e as unknown as { tool: string } & Record<string, unknown>
      access.read.push({ tool, input })
      if (access.first.includes(e.tool)) return { deny: 'not this server' }
      if (access.deny !== undefined) return { deny: access.deny }
    }
    if (e.tool === JIRA_SITES) {
      return { result: '', text: JSON.stringify({ data: { resources: [{ cloudId: 'c1', url: 'https://acme.atlassian.net' }] } }) }
    }
    if (e.tool === JIRA_SEARCH && access.jiraAnswer !== undefined) return { result: '', text: access.jiraAnswer }
    if (e.tool === JIRA_SEARCH) {
      const jql = String((e as { jql?: unknown }).jql)
      const issues = jql.startsWith('key in')
        ? [
            { key: 'ABC-1', fields: { summary: 'Build', status: { name: 'In Progress' }, priority: { name: 'Highest' } } },
            { key: 'ABC-2', fields: { summary: 'Wait', status: { name: 'In Review' }, priority: { name: 'Medium' } } },
            { key: 'ABC-5', fields: { summary: 'Parked', status: { name: 'On Hold' }, priority: { name: 'High' } } },
          ]
        : [
            { key: 'ABC-9', fields: { summary: 'Lonely ticket', status: { name: 'In Progress' }, priority: { name: 'High' } } },
            { key: 'ABC-8', fields: { summary: 'Awaiting sign-off', status: { name: 'Final Approval' }, priority: { name: 'High' } } },
            { key: 'ABC-10', fields: { summary: 'Fix "Save" button', status: { name: 'In Progress' }, priority: { name: 'Low' } } },
          ]
      return { result: '', text: JSON.stringify({ data: { issues } }) }
    }
    if (e.tool === SESSIONS) {
      const sessions = [
        { sessionId: 's1', title: 'Chaîne ABC-1', cwd: 'C:/app', isRunning: true, lastActivityAt: '2026-10-13T10:00:00Z', link: 'claude://s1' },
        { sessionId: 's3', title: 'Revue ABC-2', cwd: 'C:/app', isRunning: false, lastActivityAt: '2026-10-13T09:00:00Z', link: 'claude://s3' },
        { sessionId: 's2', title: 'Exploration libre', cwd: 'C:/app', isRunning: true, lastActivityAt: '2026-10-13T10:00:00Z', link: 'claude://s2' },
      ]
      return { result: '', text: JSON.stringify(sessions) }
    }
    if (e.tool === START || e.tool === TERMINAL || e.tool === SEND) {
      const { tool, ...input } = e as unknown as { tool: string } & Record<string, unknown>
      launched.push({ tool, input })
      return { result: '', text: 'started' }
    }
    return { deny: 'unexpected tool' }
  })
  on('prompt.fill', (_, e) => {
    prompts.push(e.text)
    return { isFilled: true, box: { text: e.text, cursor: e.text.length } } as never
  })
  return { prompts, launched, copied, readied, toasts, github, access, clock }
}

const text = (value: string | RegExp) => ({ type: 'Text', text: value })

test('/prs refresh gathers every source into lanes on each surface', async ($, on) => {
  const { launched } = host(on)
  const ran = await $.command.run({
    command: 'prs',
    args: 'refresh',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
  expect(ran.text).toContain('PR ● 3 ✔ 1')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find(text(/Blocked/))).toBeUndefined()
    expect(await ui.find(text(/Your turn/))).toBeDefined()
    expect(await ui.find(text('ABC-1 broken build'))).toBeDefined()
    expect(await ui.find(text('✖ CI'))).toBeDefined()
    expect(await ui.find(text('Review requested'))).toBeDefined()
    expect(await ui.find(text('⏫'))).toBeDefined()
    expect(await ui.find(text('◉'))).toBeDefined()
    expect(await ui.find(text('In Review'))).toBeDefined()
    expect(await ui.find(text('Ready for manual review'))).toBeDefined()
    expect(await ui.find(text('Review follow-up needed'))).toBeDefined()
    expect(await ui.find(text(/Lonely ticket/))).toBeDefined()
    expect(await ui.find(text(/Awaiting sign-off/))).toBeUndefined()
    expect(await ui.find(text(/Exploration libre/))).toBeDefined()
    expect(await ui.find(text(/bug-fixer/))).toBeDefined()
    expect(await ui.find(text(/local-uncommitted/))).toBeDefined()
    expect(await ui.find(text('draft work'))).toBeUndefined()
    expect(await ui.find(text(/On hold/))).toBeDefined()
    expect(await ui.find(text('ABC-5 parked'))).toBeUndefined()
    expect(await ui.find({ key: 'act-acme/app#1' })).toBeDefined()
    expect(await ui.find({ key: 'act-acme/app#2' })).toBeUndefined()
    expect(await ui.find({ key: 'cont-acme/app#2' })).toBeUndefined()
    expect(await ui.find({ key: 'ready-acme/app#2' })).toBeDefined()
    expect(await ui.find(text('○'))).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'act-acme/app#4' })
  expect(launched.at(-1)?.tool).toBe(START)
  expect(launched.at(-1)?.input).toMatchObject({
    initiation: 'user_asked',
    context: 'fresh',
    prompt: 'Review https://github.com/acme/app/pull/4',
    cwd: 'C:/src/app',
  })
  expect(String(launched.at(-1)?.input.consent)).toContain('Review')
  expect((await ui.find({ key: 'wip-acme/app#4' }))?.props.label).toBe('Remove')
  await ui.press({ key: 'toggle-draft' })
  expect(await ui.find(text('draft work'))).toBeDefined()
  await ui.press({ key: 'toggle-onhold' })
  expect(await ui.find(text('ABC-5 parked'))).toBeDefined()
  expect(await ui.find(text('Jira “On Hold”'))).toBeDefined()
  expect(await ui.find({ key: 'act-acme/app#5' })).toBeUndefined()
  await ui.press({ key: 'filter-reviews' })
  expect(await ui.find(text('ABC-1 broken build'))).toBeUndefined()
  expect(await ui.find(text('their change'))).toBeDefined()
  await ui.unmount()
})

test('the model-callable snapshot summarizes the lanes', async ($, on) => {
  host(on)
  const ran = await $.tool.call({ tool: 'mcp__pr-radar__snapshot', refresh: true } as never)
  expect(String(ran.result)).not.toContain('## Blocked')
  expect(String(ran.result)).toContain('acme/app#1 ABC-1 broken build — Review needed; CI failure')
  expect(String(ran.result)).toContain('acme/app#4 their change — Review requested')
  expect(String(ran.result)).toContain('## Jira issues in progress without a PR')
})

test('without start_session the next step opens a Claude Code CLI in a Terminal tab', async ($, on) => {
  const { launched, prompts } = host(on, [TERMINAL])
  await $.command.run({ command: 'prs', args: 'refresh', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'act-acme/app#6' })
  expect(launched.at(-1)).toMatchObject({
    tool: TERMINAL,
    input: {
      command: "Set-Location -LiteralPath 'C:/src/app'; & 'C:/bin/claude.exe' 'Do the review follow-up of https://github.com/acme/app/pull/6'",
    },
  })
  await ui.press({ key: 'act-acme/app#1' })
  expect(String(launched.at(-1)?.input.command)).toContain("'Review https://github.com/acme/app/pull/1'")
  await ui.press({ key: 'cont-j-ABC-10' })
  const command = String(launched.at(-1)?.input.command)
  expect(command).toStartWith("& 'C:/bin/claude.exe' 'Continue the Jira issue ABC-10 ''Fix ''Save'' button'':")
  expect(command).toContain("Fix ''Save'' button")
  expect(command).not.toContain('"')
  expect(prompts).toEqual([])
  await ui.unmount()
})

test('with no way to start a conversation the prompt lands in the composer', async ($, on) => {
  const { prompts } = host(on, [])
  await $.command.run({ command: 'prs', args: 'refresh', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'act-acme/app#4' })
  expect(prompts).toEqual(['Review https://github.com/acme/app/pull/4'])
  expect((await ui.find({ key: 'wip-acme/app#4' }))?.props.label).toBe('In progress')
  await ui.unmount()
})

test('In progress moves a PR to its own lane, Remove gives its lane back', async ($, on) => {
  host(on)
  await $.command.run({ command: 'prs', args: 'refresh', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find(text(/◐ In progress/))).toBeUndefined()
  expect((await ui.find({ key: 'wip-acme/app#6' }))?.props.label).toBe('In progress')
  await ui.press({ key: 'wip-acme/app#6' })
  expect(await ui.find(text(/◐ In progress/))).toBeDefined()
  expect(await ui.find({ key: 'act-acme/app#6' })).toBeDefined()
  expect((await ui.find({ key: 'wip-acme/app#6' }))?.props.label).toBe('Remove')
  await $.command.run({ command: 'prs', args: 'refresh', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(await ui.find(text(/◐ In progress/))).toBeDefined()
  await ui.press({ key: 'wip-acme/app#6' })
  expect(await ui.find(text(/◐ In progress/))).toBeUndefined()
  await ui.unmount()
})

test('Continue picks up unfinished sessions, runs and Jira issues', async ($, on) => {
  const { launched } = host(on, [START, SEND])
  await $.command.run({ command: 'prs', args: 'refresh', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'cont-s-s2' })
  expect(launched.at(-1)).toMatchObject({ tool: SEND, input: { session_id: 's2' } })
  expect(String(launched.at(-1)?.input.message)).toContain('where you left off')

  await ui.press({ key: 'cont-acme/app#1' })
  expect(launched.at(-1)).toMatchObject({ tool: SEND, input: { session_id: 's1' } })
  expect((await ui.find({ key: 'wip-acme/app#1' }))?.props.label).toBe('Remove')

  await ui.press({ key: 'cont-r-r2' })
  expect(launched.at(-1)?.tool).toBe(START)
  expect(String(launched.at(-1)?.input.prompt)).toContain('Agent Context run r2 (bug-fixer) on acme/tools ABC-7')
  await ui.press({ key: 'cont-j-ABC-9' })
  expect(launched.at(-1)?.tool).toBe(START)
  expect(String(launched.at(-1)?.input.prompt)).toContain('Jira issue ABC-9 “Lonely ticket”')
  expect(launched.at(-1)?.input.cwd).toBeUndefined()
  await ui.unmount()
})

test('while the pane is closed, the button above the prompt opens it', async ($, on) => {
  host(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  const band = { plugin: 'pr-radar', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 9 } } } as const
  const ui = await $.ui.mount({ ...band, surface: 'terminal' } as never)
  expect((await ui.find({ key: 'open-radar' }))?.text).toContain('PR Radar')
  await ui.press({ key: 'open-radar' })
  expect(await ui.find({ key: 'open-radar' })).toBeUndefined()
  expect(await ui.find(text('engine band'))).toBeDefined()
  await ui.unmount()
})

test('the copy icon beside a PR number copies its URL', async ($, on) => {
  const { copied } = host(on)
  await $.command.run({ command: 'prs', args: 'refresh', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'copy-url-acme/app#4' }))?.props.label).toBe('⧉')
  await ui.press({ key: 'copy-url-acme/app#4' })
  expect(copied).toEqual(['https://github.com/acme/app/pull/4'])
  await ui.unmount()
})

test('Mark ready marks my draft ready, Back to draft turns my ready PR back into a draft', async ($, on) => {
  const { readied, toasts } = host(on)
  await $.command.run({ command: 'prs', args: 'refresh', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'toggle-draft' })
  expect((await ui.find({ key: 'ready-acme/app#3' }))?.props.label).toBe('Mark ready')
  expect((await ui.find({ key: 'ready-acme/app#2' }))?.props.label).toBe('Back to draft')
  expect(await ui.find({ key: 'ready-acme/app#4' })).toBeUndefined()
  expect(await ui.find({ key: 'ready-acme/app#6' })).toBeUndefined()

  await ui.press({ key: 'ready-acme/app#3' })
  expect(readied.at(-1)).toEqual(['gh', 'pr', 'ready', 'https://github.com/acme/app/pull/3'])
  expect(toasts).toContain('app#3 is ready for review')
  await ui.press({ key: 'ready-acme/app#2' })
  expect(readied.at(-1)).toEqual(['gh', 'pr', 'ready', 'https://github.com/acme/app/pull/2', '--undo'])
  expect(toasts).toContain('app#2 is back to draft')
  await ui.unmount()
})

test('a failed gh pr ready says why in a toast', async ($, on) => {
  const { readied, toasts } = host(on, [START], 1)
  await $.command.run({ command: 'prs', args: 'refresh', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'ready-acme/app#2' })
  expect(readied).toHaveLength(1)
  expect(toasts.at(-1)).toBe('app#2: gh pr ready failed: GraphQL: Resource not accessible')
  await ui.unmount()
})

test('a gh that cannot start says so in a toast', async ($, on) => {
  const { toasts } = host(on, [START], 'deny')
  await $.command.run({ command: 'prs', args: 'refresh', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'ready-acme/app#2' })
  expect(toasts.at(-1)).toStartWith('app#2: gh pr ready failed: ')
  expect(toasts.at(-1)).toContain('gh not found')
  await ui.unmount()
})

const REFRESH = { command: 'prs', args: 'refresh', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const
const OPEN = { ...REFRESH, args: '' } as const

test('a refresh asks GitHub for the PR ids, then for the details of those found', async ($, on) => {
  const { github } = host(on)
  await $.command.run(REFRESH)
  expect(github.queries).toEqual(['ids', 'details'])
})

test('a spent GitHub budget keeps the last PRs and waits for the reset', async ($, on) => {
  const { github, clock } = host(on)
  await $.command.run(REFRESH)
  github.failure = 'gh: API rate limit exceeded for user ID 1.'
  github.resetEpoch = (NOW + 10 * 60_000) / 1000
  github.queries.length = 0
  await $.command.run(REFRESH)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find(text('ABC-1 broken build'))).toBeDefined()
  expect(await ui.find(text(/^⚠ GitHub: API rate limit reached; the radar asks again in 10 min$/))).toBeDefined()
  expect(await ui.find(text(/rate limit exceeded/))).toBeUndefined()
  await ui.unmount()

  github.queries.length = 0
  await $.command.run(REFRESH)
  expect(github.queries).toEqual([])

  github.failure = undefined
  await clock.advance(11 * 60_000)
  await $.command.run(REFRESH)
  expect(github.queries).toContain('details')
  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await after.find(text(/API rate limit/))).toBeUndefined()
  await after.unmount()
})

test('a low GitHub budget pauses the automatic refreshes, not the asked ones', async ($, on) => {
  const { github, clock } = host(on)
  github.remaining = 120
  github.resetAt = '2026-10-13T12:40:00Z'
  await $.command.run(REFRESH)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find(text(/^⚠ GitHub: API budget low; automatic refreshes wait 40 min$/))).toBeDefined()
  await ui.unmount()

  github.queries.length = 0
  await clock.advance(6 * 60_000)
  await $.command.run(OPEN)
  await clock.settle()
  expect(github.queries).toEqual([])

  await $.command.run(REFRESH)
  expect(github.queries).toEqual(['ids', 'details'])
})

test('a fresh lease of another session leaves the automatic refresh to it', async ($, on) => {
  const { github, clock } = host(on, [START], 0, { refreshLease: NOW - 30_000 })
  await $.command.run(OPEN)
  await clock.settle()
  expect(github.queries).toEqual([])

  await clock.advance(2 * 60_000)
  await $.command.run(OPEN)
  await clock.settle()
  expect(github.queries).toEqual(['ids', 'details'])
})

test('Authorize reads Jira and the sessions with the press as consent', async ($, on) => {
  const { access, toasts, clock } = host(on)
  access.asks = [JIRA_SITES, JIRA_SEARCH, SESSIONS]
  await $.command.run(OPEN)
  await clock.settle()
  expect(access.read).toEqual([])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find(text('Jira: permission needed'))).toBeDefined()

  await ui.press({ key: 'authorize' })
  expect(access.read.map(call => call.tool)).toEqual([JIRA_SITES, JIRA_SEARCH, JIRA_SEARCH, SESSIONS])
  for (const call of access.read) expect(String(call.input.consent)).toContain('pressed "Authorize"')
  expect(toasts.at(-1)).toBe('Authorized: the radar reads Jira and the sessions')
  expect(await ui.find(text(/permission needed/))).toBeUndefined()
  await ui.unmount()
})

test('a refused Authorize says which source and why', async ($, on) => {
  const { access, toasts, clock } = host(on)
  access.asks = [JIRA_SITES, JIRA_SEARCH, SESSIONS]
  await $.command.run(OPEN)
  await clock.settle()
  access.deny = 'The classifier blocked the call'
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'authorize' })
  expect(toasts.at(-1)).toBe('Still refused: Jira: The classifier blocked the call; Sessions: The classifier blocked the call')
  expect(await ui.find(text('Jira: permission needed'))).toBeDefined()
  await ui.unmount()
})

test('a Jira answer that cannot be read shows a message, not the parser error', async ($, on) => {
  const { access } = host(on)
  for (const answer of [JSON.stringify({ issues: {} }), 'not json']) {
    access.jiraAnswer = answer
    await $.command.run(REFRESH)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find(text("⚠ Jira: the Atlassian connector's answer could not be read"))).toBeDefined()
    expect(await ui.find(text(/not a function|holds no list|JSON/))).toBeUndefined()
    await ui.unmount()
  }
})

test('of two Jira servers, the one the permission rules allow is read', async ($, on) => {
  const { access } = host(on)
  const other = 'mcp__other__searchJiraIssuesUsingJql'
  access.first = [other]
  access.asks = [other]
  await $.command.run(REFRESH)
  expect(access.read.map(call => call.tool)).toContain(JIRA_SEARCH)
  expect(access.read.map(call => call.tool)).not.toContain(other)
})

test('an automatic refresh the rules allow carries no consent', async ($, on) => {
  const { access, clock } = host(on)
  await $.command.run(OPEN)
  await clock.settle()
  expect(access.read.length).toBeGreaterThan(0)
  for (const call of access.read) expect(call.input.consent).toBeUndefined()
})
