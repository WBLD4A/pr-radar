/** Who has the ball on a pull request, in the order the pane draws the lanes. */
export type Lane = 'blocked' | 'action' | 'inprogress' | 'ready' | 'waiting' | 'draft' | 'onhold'

/** How the account relates to the pull request. */
export type Role = 'author' | 'reviewer' | 'assignee'

/** The head commit's combined check state. */
export type Ci = 'success' | 'failure' | 'pending' | 'none'

/** One Jira issue as the pane shows it. */
export type JiraInfo = {
  key: string
  summary: string
  status: string
  /** Jira's status category key: `new`, `indeterminate` or `done`. */
  category: string | null
  priority: string | null
  assignee: string | null
  type: string | null
  /** The commit the latest e2e evidence comment tested, as written there; absent without evidence. */
  evidenceSha?: string
}

/** One open Claude desktop session. */
export type SessionInfo = {
  id: string
  title: string
  cwd: string
  repo: string | null
  prNumber: number | null
  isRunning: boolean
  lastActivityAt: string
  link: string | null
}

/** The latest Agent Context run of one target that is not repository-complete. */
export type RunInfo = {
  runId: string
  repo: string | null
  pr: number | null
  jiraKey: string | null
  branch: string | null
  workflow: string
  status: string
  startedAt: string
  client: string | null
  sessionId: string | null
}

/** One open pull request, classified. */
export type PrRow = {
  id: string
  repo: string
  number: number
  title: string
  url: string
  author: string
  role: Role
  isDraft: boolean
  lane: Lane
  /** The lane it would sit in when marked in progress; null otherwise. */
  heldLane: Lane | null
  /** Why it sits in its lane, in French. */
  reason: string
  ci: Ci
  hasConflicts: boolean
  /** Unresolved, not outdated review threads whose last word is someone else's. */
  openThreads: number
  reviewers: string[]
  approvals: string[]
  changesRequestedBy: string[]
  labels: string[]
  branch: string
  /** The head commit's full SHA; empty when GitHub did not give it. */
  headSha: string
  base: string
  additions: number
  deletions: number
  createdAt: string
  updatedAt: string
  jiraKey: string | null
}

/** The state of one optional source. */
export type SourceState = 'ok' | 'needs-permission' | 'unavailable' | 'error'

/** Everything one refresh gathered; shared between sessions through `$.store`. */
export type Snapshot = {
  fetchedAt: number
  login: string
  prs: PrRow[]
  jira: Record<string, JiraInfo>
  /** Issues assigned to the account and in progress. */
  jiraInProgress: JiraInfo[]
  jiraSite: string | null
  jiraState: SourceState
  sessions: SessionInfo[]
  sessionsState: SourceState
  runs: RunInfo[]
  errors: string[]
}

/** The PRs marked in progress: id -> the PR's `updatedAt` when marked; the next change clears it. */
export type Marks = Record<string, string>

/** Which pull requests the pane lists: all, your turn only, or ready for manual review only. */
export type Filter = 'all' | 'todo' | 'ready'

declare module 'claude-code' {
  interface PluginState {
    'pr-radar': {
      snapshot: Snapshot | null
      isRefreshing: boolean
      filter: Filter
      /** The lanes drawn folded; drafts and on-hold work start folded. */
      folded: Lane[]
      /** The lanes drawn folded under To do; none at first, so its drafts show. */
      foldedTodo: Lane[]
      /** The last tick's time: the pane's "now", so relative times move each minute. */
      clock: number
      /** Whether the pane is open; while it is closed the band above the prompt offers it. */
      isPaneOpen: boolean
    }
  }
}
