import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderNode } from 'claude-code'

import type { Filter, JiraInfo, Lane, Marks, PrRow, RunInfo, SessionInfo, Snapshot, SourceState } from '../types'
import {
  DETAIL_QUERY,
  ID_QUERY,
  LANES,
  LOW_BUDGET,
  actionPrompt,
  ago,
  applyJira,
  applyMarks,
  collectPrs,
  draftToggle,
  idsOf,
  isRateLimited,
  laneCounts,
  lonelyIssues as workingIssues,
  newlyUrgent,
  parseJiraIssues,
  parseSessions,
  pauseNote,
  priorityMark,
  repoOfRemote,
  runsOf,
  searches,
  sessionsOf,
  sortPrs,
  statusText,
  summary,
  withDetails,
} from './model'
import type { RawDetails, RawIds } from './model'

const PANE = 'pr-radar'
const TITLE = 'PR Radar'
const STORE_KEY = 'snapshot-v5'
const TICK_MS = 60_000
const PAUSE_KEY = 'githubPause'
const LEASE_KEY = 'refreshLease'
const LEASE_MS = 120_000

const snapshotAtom = atom({ plugin: 'pr-radar', key: 'snapshot' } as const, null)
const refreshingAtom = atom({ plugin: 'pr-radar', key: 'isRefreshing' } as const, false)
const filterAtom = atom({ plugin: 'pr-radar', key: 'filter' } as const, 'all')
const foldedAtom = atom({ plugin: 'pr-radar', key: 'folded' } as const, ['draft', 'onhold'])
const clockAtom = atom({ plugin: 'pr-radar', key: 'clock' } as const, 0)
const paneOpenAtom = atom({ plugin: 'pr-radar', key: 'isPaneOpen' } as const, false)

type Options = { agentContextPath?: string; refreshMinutes?: number }

/** GitHub refreshes paused until `until`: the budget is spent, or only low. */
type Pause = { until: number; isSpent: boolean }

/** The GitHub GraphQL points left, and when they are restored. */
type Budget = { remaining: number; resetAt: string } | null

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'todo', label: 'To do' },
  { id: 'mine', label: 'My PRs' },
  { id: 'reviews', label: 'Reviews' },
]

const matchesFilter = (row: PrRow, filter: Filter): boolean => {
  if (filter === 'mine') return row.role === 'author'
  if (filter === 'reviews') return row.role !== 'author'
  if (filter === 'todo') return ['blocked', 'action', 'inprogress', 'ready'].includes(row.lane)
  return true
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const isTimeout = (error: unknown): boolean => /still running after|timed? ?out/i.test(errorText(error))

/**
 * The connector tool whose name ends with `suffix`, among those the session
 * lists. When several servers offer it, the first one the permission rules
 * allow, so that an allow rule written for one of them applies.
 * @param suffix - The end of the tool's name, after its server.
 * @returns The tool's full name, or null when the session lists none.
 */
const findTool = async ($: EngineInterface, suffix: string): Promise<string | null> => {
  try {
    const names = (await $.tool.list()).map(tool => tool.name).filter(name => name.endsWith(suffix))
    if (names.length < 2) return names[0] ?? null
    for (const name of names) {
      const { decision } = await $.tool.check({ tool: name, input: {} }).catch(() => ({ decision: 'ask' }))
      if (decision === 'allow') return name
    }
    return names[0] ?? null
  } catch {
    return null
  }
}

/**
 * How a refresh was raised: `isAttended` when the person asked for it, and
 * their own words for the press in `consent` when a permission may be at stake.
 */
type Asked = { isAttended: boolean; consent?: string }

/**
 * Calls an MCP tool and returns its text. Unattended (a timer), a call the
 * permission check would ask about is skipped: no dialog pops up on its own.
 * Attended, the person's `consent` goes with the call.
 * @param tool - The tool's full name.
 * @param input - The tool's arguments.
 * @param asked - Whether the person asked for the refresh, and their consent to pass with the call.
 * @returns The tool's text, or the source state (needs-permission or error)
 *   with its reason when the call is skipped, refused or fails.
 */
const callTool = async (
  $: EngineInterface,
  tool: string,
  input: Record<string, unknown>,
  asked: Asked,
): Promise<{ text: string } | { state: SourceState; reason: string }> => {
  const args = {
    tool: tool as `mcp__${string}__${string}`,
    ...(asked.isAttended && asked.consent !== undefined ? { consent: asked.consent } : {}),
    ...input,
  }
  if (!asked.isAttended) {
    const { decision } = await $.tool.check({ tool: args.tool, input })
    if (decision !== 'allow') return { state: 'needs-permission', reason: `${tool} needs a permission` }
  }
  const ran = await $.tool.call(args)
  if (ran.deny !== undefined) return { state: 'needs-permission', reason: ran.deny }
  if (ran.isError === true) return { state: 'error', reason: (ran.text ?? '').slice(0, 200) }
  return { text: ran.text ?? '' }
}

/** Runs one `gh api graphql` query and returns its `data`; a GraphQL or `gh` error throws. */
const graphql = async ($: EngineInterface, query: string, fields: string[]): Promise<unknown> => {
  const ran = await $.process.run(['gh', 'api', 'graphql', '-f', `query=${query}`, ...fields.flatMap(field => ['-f', field])], {
    timeoutMs: 60_000,
  })
  if (ran.exitCode !== 0) throw new Error(`gh api graphql: ${ran.stderr.trim().slice(0, 300)}`)
  const body = JSON.parse(ran.stdout) as { data?: unknown; errors?: { message: string }[] }
  if (body.data === undefined || body.data === null) {
    throw new Error(body.errors?.map(one => one.message).join('; ') ?? 'empty response')
  }
  return body.data
}

/**
 * The open PRs of the account in two queries: their ids, then the details of
 * those found, which also tell the GraphQL budget left.
 */
const fetchPrs = async ($: EngineInterface): Promise<{ login: string; prs: PrRow[]; budget: Budget }> => {
  let login = (await $.store.get('login')) as string | undefined
  if (login === undefined) {
    const who = await $.process.run(['gh', 'api', 'user', '--jq', '.login'])
    if (who.exitCode !== 0) throw new Error(`gh api user: ${who.stderr.trim().slice(0, 200)}`)
    login = who.stdout.trim()
    await $.store.set('login', login)
  }
  const [q1, q2, q3, q4] = searches(login)
  const raw = (await graphql($, ID_QUERY, [`q1=${q1}`, `q2=${q2}`, `q3=${q3}`, `q4=${q4}`])) as RawIds
  const ids = idsOf(raw)
  if (ids.length === 0) return { login: raw.viewer.login, prs: [], budget: null }
  const details = (await graphql($, DETAIL_QUERY, ids.map(id => `ids[]=${id}`))) as RawDetails
  return { login: raw.viewer.login, prs: collectPrs(withDetails(raw, details.nodes)), budget: details.rateLimit }
}

/** When the GraphQL budget is restored, from `gh api rate_limit`, which costs none; 15 minutes when unknown. */
const resetOf = async ($: EngineInterface, now: number): Promise<number> => {
  try {
    const ran = await $.process.run(['gh', 'api', 'rate_limit', '--jq', '.resources.graphql.reset'])
    const at = Number(ran.stdout.trim()) * 1000
    if (ran.exitCode === 0 && at > now) return at
  } catch {
    // The default below.
  }
  return now + 15 * 60_000
}

/**
 * Pauses the automatic GitHub refreshes until the reset when the budget left
 * is low, and returns the note that says so; otherwise lifts the pause.
 */
const notePause = async ($: EngineInterface, budget: Budget, now: number): Promise<string | undefined> => {
  const until = budget === null ? Number.NaN : Date.parse(budget.resetAt)
  if (budget !== null && budget.remaining < LOW_BUDGET && until > now) {
    await $.store.set(PAUSE_KEY, { until, isSpent: false } satisfies Pause)
    return pauseNote(now, until, false)
  }
  if ((await $.store.get(PAUSE_KEY)) !== undefined) await $.store.delete(PAUSE_KEY)
  return undefined
}

const fetchRuns = async ($: EngineInterface, options: Options): Promise<RunInfo[]> => {
  let root = options.agentContextPath?.trim() ?? ''
  if (root === '') {
    root = `${await homeOf($)}/agent-context`
  }
  const script = `${$.plugin.root}/scripts/runs.py`
  const ran = await $.process.run(['python', '-I', script, '--root', root, '--days', '30'], { timeoutMs: 120_000 })
  if (ran.exitCode !== 0) throw new Error(`run records: ${ran.stderr.trim().slice(0, 200)}`)
  return JSON.parse(ran.stdout) as RunInfo[]
}

type JiraResult = {
  jira: Record<string, JiraInfo>
  inProgress: JiraInfo[]
  site: string | null
  state: SourceState
  error?: string
}

const JIRA_FIELDS = ['summary', 'status', 'priority', 'assignee', 'issuetype']

/** What the pane says when the Atlassian connector's answer cannot be read. */
const JIRA_UNREADABLE = "the Atlassian connector's answer could not be read"

/**
 * Reads the Jira issues of the PRs and those assigned to me in progress.
 * @param keys - The Jira keys of the PRs.
 * @param asked - How the refresh was raised, for the permission of each call.
 * @returns The issues found, the site, and whether Jira could be read.
 */
const fetchJira = async ($: EngineInterface, keys: string[], asked: Asked): Promise<JiraResult> => {
  const empty: JiraResult = { jira: {}, inProgress: [], site: null, state: 'unavailable' }
  const search = await findTool($, '__searchJiraIssuesUsingJql')
  if (search === null) return empty
  let site = (await $.store.get('jiraSite')) as { cloudId: string; url: string } | undefined
  if (site === undefined) {
    const resources = await findTool($, '__getAccessibleAtlassianResources')
    if (resources === null) return empty
    const got = await callTool($, resources, {}, asked)
    if (!('text' in got)) return { ...empty, state: got.state, error: got.reason }
    const body = JSON.parse(got.text) as { data?: { resources?: { cloudId: string; url: string }[] } }
    const first = body.data?.resources?.[0]
    if (first === undefined) return { ...empty, state: 'error', error: 'no Atlassian site' }
    site = { cloudId: first.cloudId, url: first.url }
    await $.store.set('jiraSite', site)
  }
  const jira: Record<string, JiraInfo> = {}
  if (keys.length > 0) {
    const got = await callTool(
      $,
      search,
      { cloudId: site.cloudId, jql: `key in (${keys.join(', ')})`, fields: JIRA_FIELDS, maxResults: 100 },
      asked,
    )
    if (!('text' in got)) return { ...empty, site: site.url, state: got.state, error: got.reason }
    for (const issue of parseJiraIssues(got.text)) jira[issue.key] = issue
  }
  const mine = await callTool(
    $,
    search,
    {
      cloudId: site.cloudId,
      jql: 'assignee = currentUser() AND statusCategory = "In Progress" ORDER BY priority DESC, updated DESC',
      fields: JIRA_FIELDS,
      maxResults: 30,
    },
    asked,
  )
  const inProgress = 'text' in mine ? parseJiraIssues(mine.text) : []
  for (const issue of inProgress) jira[issue.key] ??= issue
  return { jira, inProgress, site: site.url, state: 'ok' }
}

/**
 * Reads the Claude sessions and the repository of each session's folder.
 * @param asked - How the refresh was raised, for the permission of the call.
 * @returns The sessions found and whether they could be read.
 */
const fetchSessions = async (
  $: EngineInterface,
  asked: Asked,
): Promise<{ sessions: SessionInfo[]; state: SourceState; error?: string }> => {
  const tool = await findTool($, 'ccd_session_mgmt__list_sessions')
  if (tool === null) return { sessions: [], state: 'unavailable' }
  const got = await callTool($, tool, { limit: 60 }, asked)
  if (!('text' in got)) return { sessions: [], state: got.state, error: got.reason }
  const rows = parseSessions(got.text)
  const repos = ((await $.store.get('repoOfCwd')) as Record<string, string | null> | undefined) ?? {}
  let isChanged = false
  for (const cwd of new Set(rows.map(row => row.cwd))) {
    if (cwd === '' || cwd in repos) continue
    try {
      const ran = await $.process.run(['git', '-C', cwd, 'remote', 'get-url', 'origin'])
      repos[cwd] = ran.exitCode === 0 ? repoOfRemote(ran.stdout) : null
    } catch {
      repos[cwd] = null
    }
    isChanged = true
  }
  if (isChanged) await $.store.set('repoOfCwd', repos)
  return { sessions: rows.map(row => ({ ...row, repo: repos[row.cwd] ?? null })), state: 'ok' }
}

const homeOf = async ($: EngineInterface): Promise<string> =>
  (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''

/** The main local checkout of a repository: scanned once, then reused from `$.store`. */
const checkoutOf = async ($: EngineInterface, repo: string): Promise<string | null> => {
  const key = repo.toLowerCase()
  let found = (await $.store.get('checkouts')) as Record<string, string> | undefined
  if (found === undefined || !(key in found)) {
    const home = await homeOf($)
    const roots = ['', '/Documents', '/Documents/Github', '/Documents/GitHub', '/source/repos', '/repos'].flatMap(sub => [
      '--root',
      `${home}${sub}`,
    ])
    const ran = await $.process.run(['python', '-I', `${$.plugin.root}/scripts/checkouts.py`, ...roots], { timeoutMs: 60_000 })
    if (ran.exitCode === 0) {
      found = JSON.parse(ran.stdout) as Record<string, string>
      await $.store.set('checkouts', found)
    }
  }
  if (found?.[key] !== undefined) return found[key]
  // Else a folder a Claude session already worked in for that repository.
  const repos = ((await $.store.get('repoOfCwd')) as Record<string, string | null> | undefined) ?? {}
  return Object.entries(repos).find(([, one]) => one?.toLowerCase() === key)?.[0] ?? null
}

/**
 * PowerShell's single-quoted, printable-ASCII spelling of a text. Windows
 * PowerShell passes an argument to a native program without escaping its
 * double quotes, so a `"` would split it into extra arguments: double quotes
 * become single ones, and trailing backslashes, which would escape the closing
 * quote the native program sees, are dropped.
 */
const asciiQuoted = (text: string): string =>
  `'${text
    .normalize('NFD')
    .replace(/[’‘“”"]/g, "'")
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/\\+$/, '')
    .replace(/'/g, "''")}'`

/** One piece of work to pick up in a new conversation. */
type Task = { label: string; name: string; prompt: string; background: string; repo: string | null }

/**
 * Starts a new conversation for a task: a desktop session when the app offers
 * `start_session`, else a Claude Code CLI in a new Terminal tab, else the
 * prompt in this composer. Says which one through a toast; true when a new
 * conversation started.
 */
const startConversation = async ($: EngineInterface, task: Task): Promise<boolean> => {
  const cwd = task.repo === null ? null : await checkoutOf($, task.repo)
  const consent = `The user pressed "${task.label}" for ${task.name} in the PR Radar pane to start a new conversation.`
  const title = `${task.label} ${task.name}`.slice(0, 59)

  const start = await findTool($, '__start_session')
  if (start !== null) {
    const ran = await $.tool.call({
      tool: start as `mcp__${string}__${string}`,
      consent,
      initiation: 'user_asked',
      title,
      prompt: task.prompt,
      context: 'fresh',
      background: task.background,
      ...(cwd === null ? {} : { cwd }),
    })
    if (ran.deny === undefined && ran.isError !== true) {
      $.ui.toast(`New session: ${title}`, { timeoutMs: 6000 })
      return true
    }
  }

  const terminal = await findTool($, 'terminal__run_in_terminal')
  if (terminal !== null) {
    const exe = (await $.env.get('CLAUDE_CODE_EXECPATH')) ?? 'claude'
    const run = `& ${asciiQuoted(exe)} ${asciiQuoted(task.prompt)}`
    const command = cwd === null ? run : `Set-Location -LiteralPath ${asciiQuoted(cwd)}; ${run}`
    const ran = await $.tool.call({ tool: terminal as `mcp__${string}__${string}`, consent, command, title })
    if (ran.deny === undefined && ran.isError !== true) {
      $.ui.toast(`New conversation in the Terminal: ${title}`, { timeoutMs: 6000 })
      return true
    }
  }

  await $.prompt.fill({ text: task.prompt })
  $.ui.toast('No new session possible here: the prompt is in the composer', { timeoutMs: 6000 })
  return false
}

const nameOf = (repo: string | null): string => (repo === null ? '?' : (repo.split('/')[1] ?? repo))

/** A PR's next step in a new conversation; one that starts marks the PR in progress. */
const launch = async ($: EngineInterface, row: PrRow, action: { label: string; text: string }): Promise<void> => {
  const isStarted = await startConversation($, {
    label: action.label,
    name: `${nameOf(row.repo)}#${row.number}`,
    prompt: action.text,
    background: `Started from the PR Radar for the PR ${row.url} “${row.title}” (branch ${row.branch} into ${row.base}). State: ${row.reason}.${row.jiraKey === null ? '' : ` Jira issue ${row.jiraKey}.`}`,
    repo: row.repo,
  })
  if (isStarted) await setMark($, row, true)
}

const CONTINUE_TEXT = 'Resume this task where you left off: finish what remains, then tell me where things stand.'

/**
 * Continues an unfinished session where it stopped: a message sent to it
 * (queued if it is busy); a new conversation in its folder when it cannot take one.
 */
const continueSession = async ($: EngineInterface, session: SessionInfo, row: PrRow | null): Promise<void> => {
  const send = await findTool($, 'ccd_session_mgmt__send_message')
  if (send !== null) {
    const ran = await $.tool.call({
      tool: send as `mcp__${string}__${string}`,
      consent: `The user pressed "Continue" on the session "${session.title}" in the PR Radar pane.`,
      session_id: session.id,
      message: CONTINUE_TEXT,
    })
    if (ran.deny === undefined && ran.isError !== true) {
      if (row !== null) await setMark($, row, true)
      $.ui.toast(`Session resumed: ${session.title}`.slice(0, 80), { timeoutMs: 6000 })
      return
    }
  }
  const isStarted = await startConversation($, {
    label: 'Continue',
    name: session.title,
    prompt: `Resume the task of the Claude session “${session.title}” (folder ${session.cwd}): find where it stopped, finish what remains, then tell me where things stand.`,
    background: `Started from the PR Radar to continue the session “${session.title}”, which could not take a message. Its folder: ${session.cwd}.`,
    repo: session.repo,
  })
  if (isStarted && row !== null) await setMark($, row, true)
}

/** Continues an unfinished Agent Context run: in its own session when it is open, else a new conversation. */
const continueRun = async ($: EngineInterface, run: RunInfo, sessions: SessionInfo[]): Promise<void> => {
  const target = run.pr !== null ? `#${run.pr}` : (run.jiraKey ?? run.branch ?? '')
  const own = sessions.find(s => run.sessionId !== null && (s.id === run.sessionId || s.id === `local_${run.sessionId}`))
  if (own !== undefined) return continueSession($, own, null)
  const workflow = run.workflow.split(' -> ').at(-1) ?? run.workflow
  await startConversation($, {
    label: 'Continue',
    name: `${nameOf(run.repo)} ${target}`.trim(),
    prompt: `Resume the Agent Context run ${run.runId} (${workflow}) on ${run.repo ?? 'its repository'} ${target}: reread its run record, then finish the remaining steps.`,
    background: `Started from the PR Radar: the run ${run.runId} (${run.workflow}) has been “${run.status}” since ${run.startedAt}${run.client === null ? '' : `, started by ${run.client}`}.`,
    repo: run.repo,
  })
}

/** Continues a Jira issue in progress that has no PR yet, in a new conversation. */
const continueIssue = async ($: EngineInterface, issue: JiraInfo): Promise<void> => {
  await startConversation($, {
    label: 'Continue',
    name: issue.key,
    prompt: `Continue the Jira issue ${issue.key} “${issue.summary}”: check where the work stands (branch, PR, sessions), then propose and do the next steps.`,
    background: `Started from the PR Radar: ${issue.key} is “${issue.status}” in Jira, assigned to me, and has no open PR yet.`,
    repo: null,
  })
}

/**
 * Marks my PR ready for review, or turns it back into a draft, then refreshes
 * the radar. Says the result, or why `gh` failed, in a toast.
 * @param options - The mod's options, for the refresh.
 * @param row - The PR to change.
 * @param isReady - True runs `gh pr ready`, false runs `gh pr ready --undo`.
 */
const setReady = async ($: EngineInterface, options: Options, row: PrRow, isReady: boolean): Promise<void> => {
  const name = `${nameOf(row.repo)}#${row.number}`
  const argv = ['gh', 'pr', 'ready', row.url, ...(isReady ? [] : ['--undo'])]
  const ran = await $.process.run(argv, { timeoutMs: 60_000 }).catch((error: unknown) => ({
    exitCode: -1,
    stderr: error instanceof Error ? error.message : String(error),
  }))
  if (ran.exitCode !== 0) {
    $.ui.toast(`${name}: gh pr ready failed: ${ran.stderr.trim().slice(0, 160)}`, { timeoutMs: 8000 })
    return
  }
  $.ui.toast(isReady ? `${name} is ready for review` : `${name} is back to draft`, { timeoutMs: 4000 })
  await refresh($, options, true)
}

let isRunning = false

/** What a refresh found: its snapshot, and each source whose permission was refused, with the reason. */
type Refreshed = { snapshot: Snapshot; refused: string[] }

/**
 * Gathers every source into one snapshot, shares it through `$.store` and
 * redraws.
 * @param options - The mod's options.
 * @param isAttended - True when the person asked for it.
 * @param consent - The person's own words for the press, passed with the tool calls.
 * @returns What the refresh found (its snapshot and the sources still refused),
 *   or null when a refresh of this session is already running.
 */
const refresh = async ($: EngineInterface, options: Options, isAttended: boolean, consent?: string): Promise<Refreshed | null> => {
  if (isRunning) return null
  isRunning = true
  const asked: Asked = consent === undefined ? { isAttended } : { isAttended, consent }
  await update($, refreshingAtom, () => true)
  try {
    const before = await read($, snapshotAtom)
    const errors: string[] = []
    const startedAt = await $.clock.now()
    // A spent budget pauses every GitHub refresh until its reset; a low one
    // pauses only the automatic ones. The radar then keeps its last PRs.
    const pause = (await $.store.get(PAUSE_KEY)) as Pause | undefined
    const isPaused = pause !== undefined && startedAt < pause.until && (pause.isSpent || !isAttended)
    // GitHub and the run records are read side by side; a slow source that
    // times out keeps what the last refresh found rather than showing an error.
    const [github, records] = await Promise.allSettled([isPaused ? Promise.resolve(null) : fetchPrs($), fetchRuns($, options)])
    let login = before?.login ?? ''
    let prs: PrRow[] = before?.prs ?? []
    if (isPaused) errors.push(pauseNote(startedAt, pause.until, pause.isSpent))
    else if (github.status === 'fulfilled' && github.value !== null) {
      ;({ login, prs } = github.value)
      const note = await notePause($, github.value.budget, startedAt)
      if (note !== undefined) errors.push(note)
    } else if (github.status === 'rejected' && isRateLimited(errorText(github.reason))) {
      const until = await resetOf($, startedAt)
      await $.store.set(PAUSE_KEY, { until, isSpent: true } satisfies Pause)
      errors.push(pauseNote(startedAt, until, true))
    } else if (github.status === 'rejected' && !(isTimeout(github.reason) && before !== null)) {
      errors.push(`GitHub: ${errorText(github.reason)}`)
    }
    let runs: RunInfo[] = before?.runs ?? []
    if (records.status === 'fulfilled') runs = records.value
    else if (!(isTimeout(records.reason) && before !== null)) errors.push(`Agent Context: ${errorText(records.reason)}`)
    const keys = [...new Set(prs.map(row => row.jiraKey).filter((key): key is string => key !== null))]
    let jira: JiraResult
    try {
      jira = await fetchJira($, keys, asked)
    } catch {
      // A throw here comes from reading the connector's answer, whose
      // exception text means nothing to the person: name the cause instead.
      jira = { jira: before?.jira ?? {}, inProgress: before?.jiraInProgress ?? [], site: before?.jiraSite ?? null, state: 'error', error: JIRA_UNREADABLE }
    }
    if (jira.state !== 'ok' && before !== null) {
      jira = { ...jira, jira: before.jira, inProgress: before.jiraInProgress, site: jira.site ?? before.jiraSite }
    }
    if (jira.error !== undefined && jira.state === 'error') errors.push(`Jira: ${jira.error}`)
    let sessions: Awaited<ReturnType<typeof fetchSessions>>
    try {
      sessions = await fetchSessions($, asked)
    } catch (error) {
      sessions = { sessions: before?.sessions ?? [], state: 'error', error: errorText(error) }
    }
    if (sessions.state !== 'ok' && before !== null) sessions = { ...sessions, sessions: before.sessions }
    if (sessions.error !== undefined && sessions.state === 'error') errors.push(`Sessions: ${sessions.error}`)

    const snapshot: Snapshot = {
      fetchedAt: await $.clock.now(),
      login,
      prs: await withMarks($, prs.map(row => applyJira(row, jira.jira)), jira.jira),
      jira: jira.jira,
      jiraInProgress: jira.inProgress,
      jiraSite: jira.site,
      jiraState: jira.state,
      sessions: sessions.sessions,
      sessionsState: sessions.state,
      runs,
      errors,
    }
    await update($, snapshotAtom, () => snapshot)
    await $.store.set(STORE_KEY, snapshot)
    $.ui.status(statusText(snapshot))
    const urgent = newlyUrgent(before, snapshot)
    if (urgent.length === 1 && urgent[0] !== undefined) {
      $.ui.toast(`${urgent[0].repo.split('/')[1]}#${urgent[0].number}: ${urgent[0].reason}`, { timeoutMs: 8000 })
    } else if (urgent.length > 1) {
      $.ui.toast(`${urgent.length} PRs need your attention`, { timeoutMs: 8000 })
    }
    const refused = [
      ...(jira.state === 'needs-permission' ? [`Jira: ${jira.error ?? 'refused'}`] : []),
      ...(sessions.state === 'needs-permission' ? [`Sessions: ${sessions.error ?? 'refused'}`] : []),
    ]
    return { snapshot, refused }
  } finally {
    isRunning = false
    await update($, refreshingAtom, () => false)
  }
}

/**
 * The Authorize button: refreshes with the person's consent, so that reading
 * Jira and the sessions runs as their request, then says in a toast what came
 * of it.
 * @param options - The mod's options, for the refresh.
 */
const authorize = async ($: EngineInterface, options: Options): Promise<void> => {
  const consent = 'The user pressed "Authorize" in the PR Radar pane so that it reads their Jira issues and their Claude sessions.'
  const done = await refresh($, options, true, consent)
  if (done === null) {
    $.ui.toast('A refresh is running; press Authorize again once it ends', { timeoutMs: 6000 })
  } else if (done.refused.length > 0) {
    $.ui.toast(`Still refused: ${done.refused.join('; ')}`.slice(0, 200), { timeoutMs: 10_000 })
  } else {
    const { jiraState, sessionsState } = done.snapshot
    const unread = [
      ...(jiraState === 'ok' ? [] : [`Jira (${jiraState})`]),
      ...(sessionsState === 'ok' ? [] : [`the sessions (${sessionsState})`]),
    ]
    $.ui.toast(
      unread.length === 0 ? 'Authorized: the radar reads Jira and the sessions' : `Authorized, but not read: ${unread.join(', ')}`,
      { timeoutMs: unread.length === 0 ? 4000 : 8000 },
    )
  }
}

const MARKS_KEY = 'marks'

/** Applies the marks every session shares, keeping only those still current, and orders the lanes. */
const withMarks = async ($: EngineInterface, rows: PrRow[], jira: Record<string, JiraInfo>): Promise<PrRow[]> => {
  const marks = ((await $.store.get(MARKS_KEY)) as Marks | undefined) ?? {}
  const applied = applyMarks(rows, marks)
  if (Object.keys(applied.marks).length !== Object.keys(marks).length) await $.store.set(MARKS_KEY, applied.marks)
  return sortPrs(applied.rows, jira)
}

const show = async ($: EngineInterface, snapshot: Snapshot): Promise<void> => {
  await update($, snapshotAtom, () => snapshot)
  $.ui.status(statusText(snapshot))
}

/** Marks a PR in progress, or takes the mark back; its next change on GitHub drops the mark. */
const setMark = async ($: EngineInterface, row: PrRow, isOn: boolean): Promise<void> => {
  const snapshot = await read($, snapshotAtom)
  if (snapshot === null) return
  const marks = { ...(((await $.store.get(MARKS_KEY)) as Marks | undefined) ?? {}) }
  if (isOn) marks[row.id] = row.updatedAt
  else delete marks[row.id]
  await $.store.set(MARKS_KEY, marks)
  const next = { ...snapshot, prs: await withMarks($, snapshot.prs, snapshot.jira) }
  await show($, next)
  await $.store.set(STORE_KEY, next)
}

/** Adopts a fresher snapshot or marks another session stored, or refreshes once it is stale. */
const tick = async ($: EngineInterface, options: Options): Promise<void> => {
  const intervalMs = Math.max(1, options.refreshMinutes ?? 5) * 60_000
  const now = await $.clock.now()
  await update($, clockAtom, () => now)
  const stored = (await $.store.get(STORE_KEY)) as Snapshot | undefined
  const shown = await read($, snapshotAtom)
  const base = stored !== undefined && (shown === null || stored.fetchedAt > shown.fetchedAt) ? stored : shown
  if (base !== null) {
    const prs = await withMarks($, base.prs, base.jira)
    const lanes = (rows: PrRow[]): string => rows.map(row => `${row.id}:${row.lane}`).join()
    if (base !== shown || lanes(prs) !== lanes(shown.prs)) await show($, { ...base, prs })
  }
  const latest = Math.max(stored?.fetchedAt ?? 0, shown?.fetchedAt ?? 0)
  if (now - latest < intervalMs) return
  // One session refreshes for all: a lease taken since the last snapshot means
  // another session is already refreshing.
  const lease = (await $.store.get(LEASE_KEY)) as number | undefined
  if (lease !== undefined && lease > latest && now - lease < LEASE_MS) return
  await $.store.set(LEASE_KEY, now)
  await refresh($, options, false)
}

const openPane = async ($: EngineInterface, isFocused: boolean): Promise<void> => {
  await $.ui.open({ id: PANE, title: TITLE, ...(isFocused ? { focus: true as const } : {}) })
  await update($, paneOpenAtom, () => true)
}

const quietly = (work: () => Promise<unknown>): void => {
  void work().catch(() => undefined)
}

/**
 * Registers the radar: the `/prs` command, the `snapshot` tool, the periodic
 * refresh, the pane, and the button above the prompt that reopens the pane
 * while it is closed. Each PR card holds three rows split left and right: the
 * title and repository; why it is in its lane and its CI, threads and
 * priority; its number, Jira issue, linked work, age and next action.
 * @param on - Adds a hook.
 * @param rawOptions - The `userConfig` values of `plugin.json`.
 */
export const register: Register = (on, rawOptions) => {
  const options = rawOptions as Options

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'prs',
      description: 'Opens the PR Radar (GitHub PRs, Jira, Claude sessions); “/prs refresh” refreshes it',
      argumentHint: '[refresh]',
    })
    await $.tool.register({
      name: 'snapshot',
      description:
        'PR Radar: the account’s open GitHub PRs (authored, review requested, reviewed, assigned), sorted by who must act, with CI, review threads, Jira status and priority, linked Claude sessions and unfinished Agent Context work. Use it to answer “what should I do next” or “where are my PRs”.',
      inputSchema: { type: 'object', properties: { refresh: { type: 'boolean', description: 'Refresh before answering' } } },
    })
    $.clock.every(TICK_MS, () => quietly(() => tick($, options)))
    quietly(() => tick($, options))
    quietly(() => openPane($, false))

    return next(e)
  })

  on('command.run', { command: 'prs' }, async ($, e) => {
    const isRefresh = /refresh|actualise/i.test(e.args)
    await openPane($, true)
    if (isRefresh) {
      await refresh($, options, true)
      const snapshot = await read($, snapshotAtom)
      return { text: snapshot === null ? 'PR Radar refreshed.' : `PR Radar refreshed: ${statusText(snapshot) ?? 'no open PR'}.` }
    }
    quietly(() => tick($, options))
    return { text: 'PR Radar opened.' }
  })

  on('tool.call', { tool: 'mcp__pr-radar__snapshot' }, async ($, e) => {
    const wantsRefresh = (e as { refresh?: unknown }).refresh === true
    if (wantsRefresh || (await read($, snapshotAtom)) === null) await refresh($, options, true)
    const snapshot = await read($, snapshotAtom)
    const text = snapshot === null ? 'PR Radar: no data yet.' : summary(snapshot, await $.clock.now())
    return { result: text }
  }).catch(() => ({ result: 'PR Radar: cannot read the data right now.' }))

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await update($, paneOpenAtom, () => false)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snapshot = await read($, snapshotAtom)
    if (e.props.hasSurvey || (await read($, paneOpenAtom))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const counts = snapshot === null ? null : laneCounts(snapshot.prs)
    return (
      <Box flexDirection="row">
        <Button key="open-radar" plain onPress={() => quietly(() => openPane($, true))}>
          <Text color="claude">◎ </Text>
          <Text>{TITLE}</Text>
          {LANES.filter(lane => lane.id !== 'draft' && lane.id !== 'onhold' && (counts?.[lane.id] ?? 0) > 0).map(lane => (
            <Text color={lane.color}>
              {'  '}
              {lane.glyph} {counts?.[lane.id]}
            </Text>
          ))}
        </Button>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const snapshot = await read($, snapshotAtom)
    const isRefreshing = await read($, refreshingAtom)
    const filter = await read($, filterAtom)
    const folded = await read($, foldedAtom)
    const now = Math.max(await read($, clockAtom), snapshot?.fetchedAt ?? 0)

    const refreshButton = (
      <Button
        key="refresh"
        label={isRefreshing ? '…' : '↻'}
        plain
        dimColor
        onPress={() => quietly(() => refresh($, options, true))}
      />
    )

    if (snapshot === null) {
      return (
        <Box flexDirection="row" gap={1}>
          <Text dimColor>{isRefreshing ? 'Reading GitHub, Jira and the sessions…' : 'No data yet.'}</Text>
          {refreshButton}
        </Box>
      )
    }

    const counts = laneCounts(snapshot.prs)
    const rows = snapshot.prs.filter(row => matchesFilter(row, filter))
    const jiraUrl = (key: string): string | null => (snapshot.jiraSite === null ? null : `${snapshot.jiraSite}/browse/${key}`)
    const repoName = (repo: string): string => repo.split('/')[1] ?? repo

    const header = (
      <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" columnGap={2}>
        <Text>
          {LANES.filter(lane => counts[lane.id] > 0).map(lane => (
            <Text color={lane.color} dimColor={lane.id === 'onhold' || lane.id === 'draft'}>
              {lane.glyph} {counts[lane.id]}
              {'  '}
            </Text>
          ))}
        </Text>
        <Box flexDirection="row" gap={1}>
          {FILTERS.map(one => (
            <Button
              key={`filter-${one.id}`}
              label={one.label}
              plain={one.id === filter ? undefined : true}
              variant={one.id === filter ? 'primary' : undefined}
              dimColor={one.id !== filter}
              onPress={() => quietly(() => update($, filterAtom, () => one.id))}
            />
          ))}
          <Text dimColor> {isRefreshing ? '' : ago(now, snapshot.fetchedAt)}</Text>
          {refreshButton}
        </Box>
      </Box>
    )

    const notes: RenderNode[] = []
    for (const error of snapshot.errors) notes.push(<Text color="error" wrap="truncate-end">⚠ {error}</Text>)
    if (snapshot.jiraState === 'needs-permission' || snapshot.sessionsState === 'needs-permission') {
      notes.push(
        <Box flexDirection="row" gap={1}>
          <Text color="warning">{snapshot.jiraState === 'needs-permission' ? 'Jira' : 'Sessions'}: permission needed</Text>
          <Button key="authorize" label="Authorize" plain onPress={() => quietly(() => authorize($, options))} />
        </Box>,
      )
    }

    const card = (row: PrRow, color: string, isMuted: boolean): RenderNode => {
      const issue = row.jiraKey === null ? undefined : snapshot.jira[row.jiraKey]
      const sessions = sessionsOf(row, snapshot.sessions)
      const runs = runsOf(row, snapshot.runs)
      const action = isMuted ? null : actionPrompt(row)
      const canContinue = !isMuted && (row.heldLane ?? row.lane) !== 'ready'
      const toggle = isMuted ? null : draftToggle(row)
      const issueUrl = row.jiraKey === null ? null : jiraUrl(row.jiraKey)
      const mark = issue?.priority === null || issue?.priority === undefined ? null : priorityMark(issue.priority)
      const isRunning = sessions.some(s => s.isRunning)
      const signals: RenderNode[] = []
      if (row.ci === 'failure') signals.push(<Text color={isMuted ? 'inactive' : 'error'}>✖ CI</Text>)
      if (row.ci === 'pending') signals.push(<Text color="warning">◌ CI</Text>)
      if (row.ci === 'success' && !isMuted) signals.push(<Text color="success">✔</Text>)
      if (row.hasConflicts) signals.push(<Text color={isMuted ? 'inactive' : 'error'}>⚡</Text>)
      if (row.openThreads > 0) signals.push(<Text color={isMuted ? 'inactive' : 'warning'}>💬{row.openThreads}</Text>)
      if (mark !== null) signals.push(<Text color={isMuted ? 'inactive' : mark.color}>{mark.glyph}</Text>)
      return (
        <Box key={row.id} flexDirection="column" borderStyle="round" borderColor={color} borderDimColor={isMuted} paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
            <Box flexShrink={1}>
              <Text bold={!isMuted} dimColor={isMuted} wrap="truncate-end">{row.title}</Text>
            </Box>
            <Text dimColor>{repoName(row.repo)}</Text>
          </Box>
          <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
            <Box flexShrink={1}>
              <Text color={color} dimColor={isMuted} wrap="truncate-end">{row.reason}</Text>
            </Box>
            <Box flexDirection="row" columnGap={1}>{signals}</Box>
          </Box>
          <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
            <Box flexDirection="row" columnGap={2} flexShrink={1}>
              <Box flexDirection="row">
                <Link href={row.url} label={`#${row.number}`} />
                <Button
                  key={`copy-url-${row.id}`}
                  label="⧉"
                  plain
                  dimColor
                  onPress={press =>
                    quietly(async () => {
                      await $.ui.copy({ text: row.url, surface: press.surface })
                      $.ui.toast(`Link copied: ${row.url}`, { timeoutMs: 3000 })
                    })
                  }
                />
              </Box>
              {row.jiraKey !== null && issueUrl !== null ? <Link href={issueUrl} label={row.jiraKey} /> : null}
              {issue !== undefined && !isMuted ? <Text dimColor wrap="truncate-end">{issue.status}</Text> : null}
            </Box>
            <Box flexDirection="row" columnGap={1}>
              {sessions.length > 0 && sessions[0] !== undefined && canContinue ? (
                <Button
                  key={`cont-${row.id}`}
                  plain
                  onPress={() => quietly(() => continueSession($, sessions[0]!, row))}
                >
                  <Text color={isRunning ? 'claude' : 'inactive'}>{isRunning ? '◉' : '○'}</Text>
                  <Text dimColor> Continue</Text>
                </Button>
              ) : sessions.length > 0 ? (
                <Text color="inactive">{isRunning ? '◉' : '○'}</Text>
              ) : null}
              {runs.length > 0 ? <Text color="inactive">⚙</Text> : null}
              <Text dimColor>{ago(now, row.updatedAt)}</Text>
              {isMuted ? null : (
                <Button
                  key={`wip-${row.id}`}
                  label={row.lane === 'inprogress' ? 'Remove' : 'In progress'}
                  plain
                  dimColor
                  onPress={() => quietly(() => setMark($, row, row.lane !== 'inprogress'))}
                />
              )}
              {toggle !== null ? (
                <Button
                  key={`ready-${row.id}`}
                  label={toggle.label}
                  plain
                  dimColor={!toggle.isReady}
                  onPress={() => quietly(() => setReady($, options, row, toggle.isReady))}
                />
              ) : null}
              {action !== null ? (
                <Button
                  key={`act-${row.id}`}
                  label={action.label}
                  plain
                  onPress={() => quietly(() => launch($, row, action))}
                />
              ) : null}
            </Box>
          </Box>
        </Box>
      )
    }

    const foldButton = (key: string, label: RenderNode[], id: string): RenderNode => (
      <Button
        key={key}
        plain
        onPress={() =>
          quietly(() =>
            update($, foldedAtom, list =>
              list.includes(id as Lane) ? list.filter(one => one !== id) : [...list, id as Lane],
            ),
          )
        }
      >
        <Text dimColor>{folded.includes(id as Lane) ? '▸ ' : '▾ '}</Text>
        {label}
      </Button>
    )

    const lanes: RenderNode[] = []
    for (const lane of LANES) {
      const inLane = rows.filter(row => row.lane === lane.id)
      if (inLane.length === 0) continue
      const isMuted = lane.id === 'onhold'
      lanes.push(
        <Box key={`lane-${lane.id}`} flexDirection="column">
          {foldButton(
            `toggle-${lane.id}`,
            [
              <Text bold={!isMuted} color={lane.color} dimColor={isMuted}>
                {lane.glyph} {lane.label}
              </Text>,
              <Text dimColor> {inLane.length}</Text>,
            ],
            lane.id,
          )}
          {folded.includes(lane.id) ? null : (
            <Box flexDirection="column">{inLane.map(row => card(row, lane.color, isMuted))}</Box>
          )}
        </Box>,
      )
    }
    if (lanes.length === 0) lanes.push(<Text dimColor>No open PR for this filter.</Text>)

    const shownIds = new Set(snapshot.prs.map(row => row.id))
    const linkedSessions = new Set(snapshot.prs.flatMap(row => sessionsOf(row, snapshot.sessions).map(s => s.id)))
    const linkedRuns = new Set(snapshot.prs.flatMap(row => runsOf(row, snapshot.runs).map(run => run.runId)))
    const weekAgo = now - 7 * 24 * 3600_000
    const lonelyIssues = workingIssues(snapshot).slice(0, 6)
    const lonelySessions = snapshot.sessions
      .filter(s => !linkedSessions.has(s.id) && (s.isRunning || Date.parse(s.lastActivityAt) >= weekAgo))
      .slice(0, 6)
    const lonelyRuns = snapshot.runs
      .filter(
        run =>
          !linkedRuns.has(run.runId) && !(run.repo !== null && run.pr !== null && shownIds.has(`${run.repo}#${run.pr}`)),
      )
      .slice(0, 6)

    const continueButton = (key: string, work: () => Promise<unknown>): RenderNode => (
      <Button key={key} label="Continue" plain onPress={() => quietly(work)} />
    )

    const line = (key: string, left: RenderNode[], right: string, extra: RenderNode | null): RenderNode => (
      <Box key={key} flexDirection="row" justifyContent="space-between" columnGap={2}>
        <Box flexShrink={1}>
          <Text wrap="truncate-end">{left}</Text>
        </Box>
        <Box flexDirection="row" columnGap={1}>
          {right === '' ? null : <Text dimColor>{right}</Text>}
          {extra}
        </Box>
      </Box>
    )

    const section = (id: string, title: string, items: RenderNode[]): RenderNode | null => {
      if (items.length === 0) return null
      return (
        <Box key={`sec-${id}`} flexDirection="column">
          {foldButton(`toggle-${id}`, [<Text bold>{title}</Text>, <Text dimColor> {items.length}</Text>], id)}
          {folded.includes(id as Lane) ? null : (
            <Box flexDirection="column" paddingLeft={2}>
              {items}
            </Box>
          )}
        </Box>
      )
    }

    const extras =
      filter === 'mine' || filter === 'reviews'
        ? []
        : [
            section(
              'jira',
              'Jira in progress without a PR',
              lonelyIssues.map(issue => {
                const url = jiraUrl(issue.key)
                const mark = issue.priority === null ? null : priorityMark(issue.priority)
                return line(
                  `j-${issue.key}`,
                  [mark === null ? '' : <Text color={mark.color}>{mark.glyph} </Text>, <Text>{issue.summary}</Text>],
                  '',
                  <Box flexDirection="row" columnGap={1}>
                    {url === null ? <Text dimColor>{issue.key}</Text> : <Link href={url} label={issue.key} />}
                    {continueButton(`cont-j-${issue.key}`, () => continueIssue($, issue))}
                  </Box>,
                )
              }),
            ),
            section(
              'sessions',
              'Claude sessions without a PR',
              lonelySessions.map(s =>
                line(
                  `s-${s.id}`,
                  [s.isRunning ? <Text color="claude">◉ </Text> : <Text dimColor>○ </Text>, <Text>{s.title}</Text>],
                  s.isRunning ? 'running' : ago(now, s.lastActivityAt),
                  <Box flexDirection="row" columnGap={1}>
                    {continueButton(`cont-s-${s.id}`, () => continueSession($, s, null))}
                    {s.link === null ? null : (
                      <Button
                        key={`copy-${s.id}`}
                        label="⧉"
                        plain
                        dimColor
                        onPress={press => quietly(() => $.ui.copy({ text: s.link ?? '', surface: press.surface }))}
                      />
                    )}
                  </Box>,
                ),
              ),
            ),
            section(
              'runs',
              'Unfinished Agent Context work',
              lonelyRuns.map(run =>
                line(
                  `r-${run.runId}`,
                  [
                    <Text color={run.status === 'blocked' ? 'error' : 'inactive'}>⚙ </Text>,
                    <Text>
                      {run.repo === null ? '?' : repoName(run.repo)}{' '}
                      {run.pr !== null ? `#${run.pr}` : (run.jiraKey ?? run.branch ?? '')}
                    </Text>,
                    <Text dimColor> {run.workflow.split(' -> ').at(-1)}</Text>,
                  ],
                  `${run.status} · ${ago(now, run.startedAt)}`,
                  continueButton(`cont-r-${run.runId}`, () => continueRun($, run, snapshot.sessions)),
                ),
              ),
            ),
          ]

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {notes.length > 0 ? <Box flexDirection="column">{notes}</Box> : null}
        {lanes}
        {extras}
      </Box>
    )
  })
}
