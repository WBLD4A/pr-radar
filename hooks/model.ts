import type { Ci, JiraInfo, Lane, Marks, PrRow, Role, RunInfo, SessionInfo, Snapshot } from '../types'

/**
 * The first GraphQL query: the ids of the account's authored, requested,
 * reviewed and assigned open PRs. GitHub prices a query from the `first` and
 * `last` it asks for, not from what it finds, so the costly fields wait for
 * {@link DETAIL_QUERY}, which asks for the PRs found and no more.
 */
export const ID_QUERY = `query($q1:String!,$q2:String!,$q3:String!,$q4:String!){
  viewer{login}
  authored: search(query:$q1,type:ISSUE,first:50){nodes{... on PullRequest{id}}}
  requested: search(query:$q2,type:ISSUE,first:50){nodes{... on PullRequest{id}}}
  reviewed: search(query:$q3,type:ISSUE,first:50){nodes{... on PullRequest{id}}}
  assigned: search(query:$q4,type:ISSUE,first:50){nodes{... on PullRequest{id}}}
}`

/** The second GraphQL query: the details of the PRs found, and the budget left. */
export const DETAIL_QUERY = `query($ids:[ID!]!){
  rateLimit{remaining resetAt}
  nodes(ids:$ids){...P}
}
fragment P on PullRequest{
  id number title url isDraft createdAt updatedAt headRefName baseRefName
  additions deletions
  repository{nameWithOwner}
  author{login}
  reviewDecision mergeable
  labels(first:10){nodes{name}}
  reviewRequests(first:10){nodes{requestedReviewer{... on User{login} ... on Team{slug}}}}
  latestOpinionatedReviews(first:20){nodes{author{login} state submittedAt}}
  latestReviews(first:20){nodes{author{login} state submittedAt}}
  reviewThreads(first:100){nodes{isResolved isOutdated comments(last:1){nodes{author{login}}}}}
  commits(last:1){nodes{commit{committedDate statusCheckRollup{state}}}}
}`

/** The four search strings, for one login. */
export const searches = (login: string): [string, string, string, string] => {
  const open = 'is:pr is:open archived:false'
  return [
    `${open} author:${login}`,
    `${open} review-requested:${login}`,
    `${open} reviewed-by:${login} -author:${login}`,
    `${open} assignee:${login} -author:${login}`,
  ]
}

type Login = { login?: string } | null
type Review = { author: Login; state: string; submittedAt: string | null }
/** One pull request as the GitHub GraphQL search returns it. */
export type RawPr = {
  id: string
  number: number
  title: string
  url: string
  isDraft: boolean
  createdAt: string
  updatedAt: string
  headRefName: string
  baseRefName: string
  additions: number
  deletions: number
  repository: { nameWithOwner: string }
  author: Login
  reviewDecision: string | null
  mergeable: string | null
  labels: { nodes: { name: string }[] }
  reviewRequests: { nodes: { requestedReviewer: { login?: string; slug?: string } | null }[] }
  latestOpinionatedReviews: { nodes: Review[] }
  latestReviews: { nodes: Review[] }
  reviewThreads: {
    nodes: { isResolved: boolean; isOutdated: boolean; comments: { nodes: { author: Login }[] } }[]
  }
  commits: {
    nodes: { commit: { committedDate: string; statusCheckRollup: { state: string } | null } }[]
  }
}
/** The GraphQL answer: the viewer and one search per role. */
export type RawSearch = {
  viewer: { login: string }
  authored: { nodes: (RawPr | Record<string, never>)[] }
  requested: { nodes: (RawPr | Record<string, never>)[] }
  reviewed: { nodes: (RawPr | Record<string, never>)[] }
  assigned: { nodes: (RawPr | Record<string, never>)[] }
}

type Ids = { nodes: { id?: string }[] }
/** The {@link ID_QUERY} answer: the viewer and the PR ids of each role. */
export type RawIds = { viewer: { login: string }; authored: Ids; requested: Ids; reviewed: Ids; assigned: Ids }
/** The {@link DETAIL_QUERY} answer. */
export type RawDetails = { rateLimit: { remaining: number; resetAt: string } | null; nodes: (RawPr | null)[] }

/** The most PRs {@link DETAIL_QUERY} asks for, the `nodes(ids:)` limit. */
export const MAX_PRS = 100

/**
 * The distinct PR ids of the four searches, authored first, then requested,
 * reviewed and assigned, at most {@link MAX_PRS}.
 * @param raw - The {@link ID_QUERY} answer.
 * @returns The ids to ask {@link DETAIL_QUERY} for.
 */
export const idsOf = (raw: RawIds): string[] => {
  const ids = [raw.authored, raw.requested, raw.reviewed, raw.assigned].flatMap(part =>
    part.nodes.map(node => node.id).filter((id): id is string => id !== undefined),
  )
  return [...new Set(ids)].slice(0, MAX_PRS)
}

/**
 * The searches again, each id replaced by its details; an id without details
 * (a PR closed between the two queries) is left out.
 * @param raw - The {@link ID_QUERY} answer.
 * @param details - The PRs of the {@link DETAIL_QUERY} answer.
 * @returns What {@link collectPrs} reads.
 */
export const withDetails = (raw: RawIds, details: (RawPr | null)[]): RawSearch => {
  const byId = new Map(details.filter((pr): pr is RawPr => pr !== null).map(pr => [pr.id, pr]))
  const fill = (part: Ids): { nodes: RawPr[] } => ({
    nodes: part.nodes.flatMap(node => {
      const pr = node.id === undefined ? undefined : byId.get(node.id)
      return pr === undefined ? [] : [pr]
    }),
  })
  return {
    viewer: raw.viewer,
    authored: fill(raw.authored),
    requested: fill(raw.requested),
    reviewed: fill(raw.reviewed),
    assigned: fill(raw.assigned),
  }
}

/** Below this many GraphQL points left, an automatic refresh waits for the reset. */
export const LOW_BUDGET = 300

/** Whether a `gh` error says the GitHub API rate limit is spent. */
export const isRateLimited = (text: string): boolean => /rate limit/i.test(text)

/**
 * The note shown while GitHub refreshes are paused.
 * @param now - The time now, in milliseconds.
 * @param until - When the pause ends, in milliseconds.
 * @param isSpent - True when the budget is spent, false when it is only low.
 * @returns The note, saying when the radar asks GitHub again.
 */
export const pauseNote = (now: number, until: number, isSpent: boolean): string => {
  const minutes = Math.max(1, Math.ceil((until - now) / 60000))
  return isSpent
    ? `GitHub: API rate limit reached; the radar asks again in ${minutes} min`
    : `GitHub: API budget low; automatic refreshes wait ${minutes} min`
}

/** The lanes, in display order, with their label, glyph and theme color. */
export const LANES: { id: Lane; label: string; glyph: string; color: string }[] = [
  { id: 'blocked', label: 'Blocked', glyph: '✖', color: 'error' },
  { id: 'action', label: 'Your turn', glyph: '●', color: 'warning' },
  { id: 'inprogress', label: 'In progress', glyph: '◐', color: 'claude' },
  { id: 'ready', label: 'Ready for manual review', glyph: '✔', color: 'success' },
  { id: 'waiting', label: 'Waiting on others', glyph: '◷', color: 'suggestion' },
  { id: 'draft', label: 'Drafts', glyph: '✎', color: 'inactive' },
  { id: 'onhold', label: 'On hold', glyph: '⏸', color: 'inactive' },
]

const JIRA_KEY = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/

/** The first Jira key in the given texts, in order. */
export const jiraKeyOf = (...texts: (string | null | undefined)[]): string | null => {
  for (const text of texts) {
    const match = text === null || text === undefined ? null : JIRA_KEY.exec(text)
    if (match?.[1] !== undefined) return match[1]
  }
  return null
}

const BLOCKED_TEXT = /block|bloqu|impediment/i
const ON_HOLD_TEXT = /on.?hold|en pause|paused|postponed|deferred|report[ée]/i

/** Whether a Jira status or a label says the work is blocked. */
export const isBlockedText = (text: string | null | undefined): boolean =>
  text !== null && text !== undefined && BLOCKED_TEXT.test(text)

/** Whether a Jira status or a label says the work is parked for later. */
export const isOnHoldText = (text: string | null | undefined): boolean =>
  text !== null && text !== undefined && ON_HOLD_TEXT.test(text)

/**
 * Whether a Jira status means someone is working on the issue right now:
 * `In Progress` itself, not the later steps of the same category such as
 * `Code Review` or `Final Approval`.
 */
export const isWorkingStatus = (status: string | null | undefined): boolean =>
  status !== null && status !== undefined && /^(in progress|en cours)$/i.test(status.trim())

/** My Jira issues really in progress that no listed PR carries. */
export const lonelyIssues = (snapshot: Snapshot): JiraInfo[] => {
  const linkedKeys = new Set(snapshot.prs.map(row => row.jiraKey))
  return snapshot.jiraInProgress.filter(issue => isWorkingStatus(issue.status) && !linkedKeys.has(issue.key))
}

const ciOf = (state: string | undefined): Ci => {
  if (state === 'SUCCESS') return 'success'
  if (state === 'FAILURE' || state === 'ERROR') return 'failure'
  if (state === 'PENDING' || state === 'EXPECTED') return 'pending'
  return 'none'
}

const loginOf = (who: Login): string => who?.login ?? 'ghost'

const isPr = (node: RawPr | Record<string, never>): node is RawPr =>
  typeof (node as RawPr).number === 'number'


/** Whether a label is the `request-changes` review outcome (or `request change`). */
export const isChangesLabel = (name: string): boolean => /^request[ -]?changes?$/i.test(name.trim())

/** Whether a label is the `approved` review outcome. */
export const isApprovedLabel = (name: string): boolean => /^approved?$/i.test(name.trim())

/** The states of my own PRs that the review labels decide. */
export const REASON = {
  followUp: 'Review follow-up needed',
  manualReview: 'Ready for manual review',
  review: 'Review needed',
} as const

/** Classifies one pull request from the account's point of view. */
export const classify = (raw: RawPr, me: string, role: Role): PrRow => {
  const head = raw.commits.nodes[0]?.commit
  const lastCommitAt = head?.committedDate ?? raw.createdAt
  const ci = ciOf(head?.statusCheckRollup?.state)
  const hasConflicts = raw.mergeable === 'CONFLICTING'
  const labels = raw.labels.nodes.map(label => label.name)
  const reviewers = raw.reviewRequests.nodes
    .map(node => node.requestedReviewer?.login ?? node.requestedReviewer?.slug)
    .filter((name): name is string => name !== undefined)
  const opinions = raw.latestOpinionatedReviews.nodes
  const approvals = opinions.filter(r => r.state === 'APPROVED').map(r => loginOf(r.author))
  const changes = opinions.filter(r => r.state === 'CHANGES_REQUESTED')
  const changesRequestedBy = changes.map(r => loginOf(r.author))
  const author = loginOf(raw.author)
  const openThreads = raw.reviewThreads.nodes.filter(thread => {
    if (thread.isResolved || thread.isOutdated) return false
    const last = thread.comments.nodes[0]
    return last === undefined || loginOf(last.author) !== (role === 'author' ? me : author)
  }).length

  const base = {
    id: `${raw.repository.nameWithOwner}#${raw.number}`,
    repo: raw.repository.nameWithOwner,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author,
    role,
    isDraft: raw.isDraft,
    ci,
    hasConflicts,
    openThreads,
    reviewers,
    approvals,
    changesRequestedBy,
    labels,
    branch: raw.headRefName,
    base: raw.baseRefName,
    additions: raw.additions,
    deletions: raw.deletions,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    jiraKey: jiraKeyOf(raw.title, raw.headRefName),
  }
  const place = (lane: Lane, reason: string): PrRow => ({ ...base, lane, heldLane: null, reason })

  const heldLabel = labels.find(isOnHoldText)
  if (heldLabel !== undefined) return place('onhold', `Label “${heldLabel}”`)
  const blockedLabel = labels.find(isBlockedText)
  if (blockedLabel !== undefined) return place('blocked', `Label “${blockedLabel}”`)

  if (role === 'author') {
    if (raw.isDraft) {
      if (ci === 'failure') return place('draft', 'Draft · CI failing')
      if (hasConflicts) return place('draft', 'Draft · conflicts')
      return place('draft', 'Draft')
    }
    if (hasConflicts) return place('blocked', `Conflicts with ${raw.baseRefName}`)
    // The review workflow keeps one outcome label on the PR: it decides the state.
    if (labels.some(isChangesLabel)) return place('action', REASON.followUp)
    if (labels.some(isApprovedLabel)) return place('ready', REASON.manualReview)
    return place('action', REASON.review)
  }

  if (raw.isDraft) return place('draft', `Draft by ${author}`)
  const mine = raw.latestReviews.nodes.find(r => loginOf(r.author) === me)
  const isRequested = reviewers.includes(me)
  if (isRequested) {
    return place('action', mine === undefined ? 'Review requested' : 'Re-review requested')
  }
  if (mine !== undefined) {
    const after = mine.submittedAt !== null && lastCommitAt > mine.submittedAt
    if (mine.state === 'APPROVED') return place('waiting', 'Approved by you · waiting for the merge')
    if (after) return place('action', 'New commits since your review')
    if (openThreads > 0 || mine.state === 'CHANGES_REQUESTED') {
      return place('waiting', `Waiting for ${author}’s follow-up`)
    }
    return place('waiting', 'Commented by you')
  }
  if (role === 'assignee') return place('waiting', `Assigned · author ${author}`)
  return place('waiting', `By ${author}`)
}

/** Every open pull request of the four searches, once each, the strongest role first. */
export const collectPrs = (data: RawSearch): PrRow[] => {
  const me = data.viewer.login
  const seen = new Map<string, PrRow>()
  const take = (nodes: (RawPr | Record<string, never>)[], role: Role): void => {
    for (const node of nodes) {
      if (!isPr(node)) continue
      const id = `${node.repository.nameWithOwner}#${node.number}`
      if (!seen.has(id)) seen.set(id, classify(node, me, role))
    }
  }
  take(data.authored.nodes, 'author')
  take(data.requested.nodes, 'reviewer')
  take(data.reviewed.nodes, 'reviewer')
  take(data.assigned.nodes, 'assignee')
  return [...seen.values()]
}

/**
 * A Jira status on hold parks any PR out of the way; a blocked status blocks
 * my PR otherwise not in a worse lane.
 */
export const applyJira = (row: PrRow, jira: Record<string, JiraInfo>): PrRow => {
  const issue = row.jiraKey === null ? undefined : jira[row.jiraKey]
  if (issue === undefined) return row
  if (isOnHoldText(issue.status)) return { ...row, lane: 'onhold', reason: `Jira “${issue.status}”` }
  if (row.lane === 'blocked' || row.role !== 'author') return row
  if (isBlockedText(issue.status)) return { ...row, lane: 'blocked', reason: `Jira “${issue.status}”` }
  return row
}

const PRIORITY_RANK: Record<string, number> = {
  blocker: 0,
  highest: 0,
  critical: 0.5,
  'very high': 0.5,
  high: 1,
  medium: 2,
  low: 3,
  'very low': 4,
  lowest: 5,
}

/** Lower is more urgent; an unknown priority ranks as medium. */
export const priorityRank = (priority: string | null | undefined): number =>
  priority === null || priority === undefined ? 2.5 : (PRIORITY_RANK[priority.toLowerCase()] ?? 2.5)

/** Arrow and color of a Jira priority. */
export const priorityMark = (priority: string): { glyph: string; color: string } => {
  const rank = priorityRank(priority)
  if (rank <= 0.5) return { glyph: '⏫', color: 'error' }
  if (rank <= 1) return { glyph: '▲', color: 'warning' }
  if (rank <= 2.5) return { glyph: '■', color: 'suggestion' }
  return { glyph: '▼', color: 'inactive' }
}

/** Lane order, then Jira priority, then the most recently updated. */
export const sortPrs = (rows: PrRow[], jira: Record<string, JiraInfo>): PrRow[] => {
  const laneRank = (lane: Lane): number => LANES.findIndex(one => one.id === lane)
  const prio = (row: PrRow): number =>
    priorityRank(row.jiraKey === null ? null : jira[row.jiraKey]?.priority)
  return [...rows].sort(
    (a, b) =>
      laneRank(a.lane) - laneRank(b.lane) ||
      prio(a) - prio(b) ||
      b.updatedAt.localeCompare(a.updatedAt),
  )
}

/**
 * Puts the PRs marked in progress in their lane, and gives the others back
 * theirs. A mark holds while the PR's `updatedAt` is the one it was marked at:
 * the PR's next change (a push, a label, a review) or its closing drops it.
 */
export const applyMarks = (rows: PrRow[], marks: Marks): { rows: PrRow[]; marks: Marks } => {
  const kept: Marks = {}
  const placed = rows.map(row => {
    const lane = row.heldLane ?? row.lane
    if (marks[row.id] !== row.updatedAt || lane === 'onhold') return { ...row, lane, heldLane: null }
    kept[row.id] = row.updatedAt
    return { ...row, lane: 'inprogress' as const, heldLane: lane }
  })
  return { rows: placed, marks: kept }
}

type JiraIssue = { key: string; fields?: Record<string, unknown> }

type JiraIssues = JiraIssue[] | { nodes?: JiraIssue[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } }

type JiraAnswer = { issues?: JiraIssues; nextPageToken?: string; isLast?: boolean }

/**
 * Reads one page of the Atlassian connector's JQL answer. The connector has
 * answered with `issues` as a list, under `data` or not, with `nextPageToken`
 * and `isLast` beside it, and now answers with the list in `issues.nodes` and
 * the next page's token in `issues.pageInfo.endCursor`.
 * @param text - The connector's answer.
 * @returns The issues, none when the answer holds no `issues`, and the token
 *   to pass as `nextPageToken` for the next page, null on the last page.
 * @throws When the answer is not JSON or its `issues` holds no list.
 */
export const parseJiraPage = (text: string): { issues: JiraInfo[]; next: string | null } => {
  const body = JSON.parse(text) as (JiraAnswer & { data?: JiraAnswer }) | null
  const answer = body?.data ?? body ?? {}
  const found = answer.issues ?? []
  const issues = Array.isArray(found) ? found : found.nodes
  if (!Array.isArray(issues)) throw new Error('the Jira answer holds no list of issues')
  const pageInfo = Array.isArray(found) ? undefined : found.pageInfo
  const next = pageInfo === undefined
    ? answer.isLast === true ? null : answer.nextPageToken ?? null
    : pageInfo.hasNextPage === true ? pageInfo.endCursor ?? null : null
  const infos = issues.map(issue => {
    const f = (issue.fields ?? {}) as {
      summary?: string
      status?: { name?: string; statusCategory?: { key?: string } }
      priority?: { name?: string } | null
      assignee?: { displayName?: string } | null
      issuetype?: { name?: string }
    }
    return {
      key: issue.key,
      summary: f.summary ?? '',
      status: f.status?.name ?? '?',
      category: f.status?.statusCategory?.key ?? null,
      priority: f.priority?.name ?? null,
      assignee: f.assignee?.displayName ?? null,
      type: f.issuetype?.name ?? null,
    }
  })
  return { issues: infos, next }
}

/** Reads the desktop app's `list_sessions` answer. */
export const parseSessions = (text: string): Omit<SessionInfo, 'repo'>[] => {
  const rows = JSON.parse(text) as {
    sessionId: string
    title?: string
    cwd?: string
    isArchived?: boolean
    isRunning?: boolean
    prNumber?: number
    lastActivityAt?: string
    link?: string
  }[]
  return rows
    .filter(row => row.isArchived !== true)
    .map(row => ({
      id: row.sessionId,
      title: row.title ?? row.sessionId,
      cwd: row.cwd ?? '',
      prNumber: row.prNumber ?? null,
      isRunning: row.isRunning === true,
      lastActivityAt: row.lastActivityAt ?? '',
      link: row.link ?? null,
    }))
}

/** `owner/repo` from a Git remote URL. */
export const repoOfRemote = (url: string): string | null => {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\s*$/i.exec(url.trim())
  return match === null ? null : `${match[1]}/${match[2]}`
}

const sameRepo = (a: string | null, b: string | null): boolean =>
  a !== null && b !== null && a.toLowerCase() === b.toLowerCase()

/** The sessions working on a pull request: its number in its repository, or its Jira key. */
export const sessionsOf = (row: PrRow, sessions: SessionInfo[]): SessionInfo[] =>
  sessions.filter(
    s =>
      (s.prNumber === row.number && sameRepo(s.repo, row.repo)) ||
      (row.jiraKey !== null && jiraKeyOf(s.title) === row.jiraKey),
  )

/** The unfinished Agent Context runs of a pull request. */
export const runsOf = (row: PrRow, runs: RunInfo[]): RunInfo[] =>
  runs.filter(
    run =>
      (sameRepo(run.repo, row.repo) && (run.pr === row.number || run.branch === row.branch)) ||
      (row.jiraKey !== null && run.jiraKey === row.jiraKey),
  )

/** Counts per lane, for the status line and the pane's header. */
export const laneCounts = (rows: PrRow[]): Record<Lane, number> => {
  const counts: Record<Lane, number> = { blocked: 0, action: 0, inprogress: 0, ready: 0, waiting: 0, draft: 0, onhold: 0 }
  for (const row of rows) counts[row.lane] += 1
  return counts
}

/** The one status-line text; undefined when there is nothing open. */
export const statusText = (snapshot: Snapshot): string | undefined => {
  if (snapshot.prs.length === 0) return undefined
  const counts = laneCounts(snapshot.prs)
  const parts = LANES.filter(lane => lane.id !== 'draft' && lane.id !== 'onhold' && counts[lane.id] > 0).map(
    lane => `${lane.glyph} ${counts[lane.id]}`,
  )
  return `PR ${parts.length === 0 ? `✎ ${counts.draft}` : parts.join(' ')}`
}

/** The PRs that entered the blocked or action lanes since the previous snapshot. */
export const newlyUrgent = (before: Snapshot | null, after: Snapshot): PrRow[] => {
  if (before === null) return []
  const was = new Map(before.prs.map(row => [row.id, row.lane]))
  return after.prs.filter(
    row => (row.lane === 'blocked' || row.lane === 'action') && was.get(row.id) !== row.lane,
  )
}

/** "3 min", "2 h", "4 d" since an ISO date or a timestamp. */
export const ago = (now: number, when: string | number): string => {
  const at = typeof when === 'number' ? when : Date.parse(when)
  if (Number.isNaN(at)) return ''
  const minutes = Math.max(0, Math.round((now - at) / 60000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h`
  return `${Math.round(hours / 24)} d`
}

/**
 * The prompt a row's main action puts in the composer; none for parked work
 * or for my PR ready for manual review, which the person reviews by hand.
 */
export const actionPrompt = (marked: PrRow): { label: string; text: string } | null => {
  const row = { ...marked, lane: marked.heldLane ?? marked.lane }
  if (row.lane === 'onhold' || row.lane === 'draft' || row.lane === 'ready') return null
  if (row.role !== 'author' && row.lane === 'action') {
    return { label: 'Review', text: `Review ${row.url}` }
  }
  if (row.hasConflicts) {
    return { label: 'Resolve', text: `Resolve the conflicts of ${row.url} with ${row.base}` }
  }
  if (row.role === 'author' && row.reason === REASON.followUp) {
    return { label: 'Follow-up', text: `Do the review follow-up of ${row.url}` }
  }
  if (row.role === 'author' && row.reason === REASON.review) {
    return { label: 'Start the review', text: `Review ${row.url}` }
  }
  return { label: 'Resume', text: `Where does ${row.url} stand? Suggest the next step.` }
}

/**
 * The button that moves my PR between draft and ready for review: my drafts
 * become ready, and the ones ready for manual review go back to draft.
 * @param row - The PR of the card, with its lane before any in-progress mark in `heldLane`.
 * @returns The button's label and the state its press sets (`isReady` true marks
 * the PR ready, false turns it back into a draft), or null when the card has no button.
 */
export const draftToggle = (row: PrRow): { label: string; isReady: boolean } | null => {
  if (row.role !== 'author') return null
  if (row.isDraft) return { label: 'Mark ready', isReady: true }
  if ((row.heldLane ?? row.lane) === 'ready') return { label: 'Back to draft', isReady: false }
  return null
}

/** A plain-text summary for the model-callable tool. */
export const summary = (snapshot: Snapshot, now: number): string => {
  const age = ago(now, snapshot.fetchedAt)
  const lines = [`PR Radar of ${snapshot.login}, refreshed ${age === 'just now' ? age : `${age} ago`}.`]
  for (const lane of LANES) {
    const rows = snapshot.prs.filter(row => row.lane === lane.id)
    if (rows.length === 0) continue
    lines.push('', `## ${lane.label} (${rows.length})`)
    for (const row of rows) {
      const issue = row.jiraKey === null ? undefined : snapshot.jira[row.jiraKey]
      const jira =
        issue === undefined ? (row.jiraKey ?? '') : `${issue.key} ${issue.status} ${issue.priority ?? ''}`
      const sessions = sessionsOf(row, snapshot.sessions).map(s => `session “${s.title}”`)
      lines.push(
        `- ${row.id} ${row.title} — ${row.reason}; CI ${row.ci}; ${jira}`.trim() +
          (sessions.length > 0 ? `; ${sessions.join(', ')}` : '') +
          ` <${row.url}>`,
      )
    }
  }
  const lonely = lonelyIssues(snapshot)
  if (lonely.length > 0) {
    lines.push('', '## Jira issues in progress without a PR')
    for (const issue of lonely) lines.push(`- ${issue.key} ${issue.summary} — ${issue.status}`)
  }
  if (snapshot.runs.length > 0) {
    lines.push('', '## Unfinished Agent Context work')
    for (const run of snapshot.runs.slice(0, 15)) {
      lines.push(
        `- ${run.repo ?? '?'} ${run.pr === null ? (run.jiraKey ?? run.branch ?? '') : `#${run.pr}`} — ${run.workflow} (${run.status}, ${run.startedAt})`,
      )
    }
  }
  if (snapshot.errors.length > 0) lines.push('', `Errors: ${snapshot.errors.join('; ')}`)
  return lines.join('\n')
}
