import { describe, expect, test } from 'claude-code/testing'

import {
  actionPrompt,
  applyJira,
  applyMarks,
  classify,
  collectPrs,
  draftToggle,
  idsOf,
  isRateLimited,
  isWorkingStatus,
  jiraKeyOf,
  lonelyIssues,
  newlyUrgent,
  parseJiraIssues,
  parseSessions,
  pauseNote,
  repoOfRemote,
  sessionsOf,
  sortPrs,
  statusText,
  withDetails,
} from '../hooks/model'
import type { Snapshot } from '../types'
import { ME, rawPr, search } from './fixtures'

const CHANGES = { author: 'alice', state: 'CHANGES_REQUESTED', submittedAt: '2026-10-06T10:00:00Z' }

describe('my pull requests', () => {
  test('a conflict blocks a ready PR, a failing CI does not, a draft stays a draft', () => {
    expect(classify(rawPr({ ci: 'FAILURE' }), ME, 'author')).toMatchObject({ lane: 'action', reason: 'Review needed', ci: 'failure' })
    expect(classify(rawPr({ mergeable: 'CONFLICTING' }), ME, 'author')).toMatchObject({ lane: 'blocked', reason: 'Conflicts with main' })
    expect(classify(rawPr({ isDraft: true, ci: 'FAILURE' }), ME, 'author')).toMatchObject({ lane: 'draft', reason: 'Draft · CI failing' })
    expect(classify(rawPr({ isDraft: true, labels: ['blocked'] }), ME, 'author').lane).toBe('blocked')
  })

  test('the review labels decide the state of my ready PRs', () => {
    expect(classify(rawPr({ labels: ['request-changes'] }), ME, 'author')).toMatchObject({
      lane: 'action',
      reason: 'Review follow-up needed',
    })
    expect(classify(rawPr({ labels: ['request change'] }), ME, 'author').reason).toBe('Review follow-up needed')
    expect(classify(rawPr({ labels: ['approved'] }), ME, 'author')).toMatchObject({
      lane: 'ready',
      reason: 'Ready for manual review',
    })
    expect(classify(rawPr({ requested: ['bob'], reviews: [CHANGES] }), ME, 'author')).toMatchObject({
      lane: 'action',
      reason: 'Review needed',
    })
    expect(classify(rawPr({ labels: ['approved'], ci: 'FAILURE' }), ME, 'author').lane).toBe('ready')
  })

  test('each review state starts its own next step', () => {
    const url = 'https://github.com/acme/app/pull/1'
    expect(actionPrompt(classify(rawPr({ labels: ['request-changes'] }), ME, 'author'))).toEqual({
      label: 'Follow-up',
      text: `Do the review follow-up of ${url}`,
    })
    expect(actionPrompt(classify(rawPr({ labels: ['approved'] }), ME, 'author'))).toBeNull()
    expect(actionPrompt(classify(rawPr(), ME, 'author'))).toEqual({ label: 'Start the review', text: `Review ${url}` })
  })

  test('my drafts can be made ready, and my PRs ready for manual review can go back to draft', () => {
    expect(draftToggle(classify(rawPr({ isDraft: true }), ME, 'author'))).toEqual({ label: 'Mark ready', isReady: true })
    expect(draftToggle(classify(rawPr({ isDraft: true, ci: 'FAILURE' }), ME, 'author'))?.isReady).toBe(true)
    const ready = classify(rawPr({ labels: ['approved'] }), ME, 'author')
    expect(draftToggle(ready)).toEqual({ label: 'Back to draft', isReady: false })
    expect(draftToggle({ ...ready, lane: 'inprogress', heldLane: 'ready' })).toEqual({ label: 'Back to draft', isReady: false })
    expect(draftToggle(classify(rawPr({ labels: ['request-changes'] }), ME, 'author'))).toBeNull()
    expect(draftToggle(classify(rawPr({ isDraft: true, author: 'bob' }), ME, 'reviewer'))).toBeNull()
  })
})

describe('work marked in progress', () => {
  test('a mark holds until the PR changes, and gives the lane back', () => {
    const row = classify(rawPr({ labels: ['request-changes'] }), ME, 'author')
    const marked = applyMarks([row], { [row.id]: row.updatedAt })
    expect(marked.rows[0]).toMatchObject({ lane: 'inprogress', heldLane: 'action' })
    expect(marked.marks).toEqual({ [row.id]: row.updatedAt })
    expect(actionPrompt(marked.rows[0]!)?.label).toBe('Follow-up')
    expect(applyMarks(marked.rows, marked.marks).rows[0]?.lane).toBe('inprogress')
    const changed = { ...marked.rows[0]!, updatedAt: '2026-10-11T10:00:00Z' }
    expect(applyMarks([changed], marked.marks)).toEqual({ rows: [{ ...changed, lane: 'action', heldLane: null }], marks: {} })
    expect(applyMarks([], marked.marks).marks).toEqual({})
    const held = { ...row, lane: 'onhold' as const }
    expect(applyMarks([held], { [row.id]: row.updatedAt }).rows[0]?.lane).toBe('onhold')
  })
})

describe('pull requests I review', () => {
  test('a request is mine; my review then waits for the author until new commits land', () => {
    expect(classify(rawPr({ author: 'bob', requested: [ME] }), ME, 'reviewer')).toMatchObject({ lane: 'action', reason: 'Review requested' })
    const mine = { author: ME, state: 'CHANGES_REQUESTED', submittedAt: '2026-10-06T10:00:00Z' }
    expect(classify(rawPr({ author: 'bob', reviews: [mine] }), ME, 'reviewer')).toMatchObject({
      lane: 'waiting',
      reason: 'Waiting for bob’s follow-up',
    })
    expect(classify(rawPr({ author: 'bob', reviews: [mine], lastCommitAt: '2026-10-08T10:00:00Z' }), ME, 'reviewer'))
      .toMatchObject({ lane: 'action', reason: 'New commits since your review' })
    expect(classify(rawPr({ author: 'bob', requested: [ME], reviews: [mine] }), ME, 'reviewer').reason).toBe('Re-review requested')
  })

  test('a PR found by several searches is listed once, under its first role', () => {
    const pr = rawPr({ number: 7, author: 'bob', requested: [ME] })
    const rows = collectPrs(search({ requested: [pr], reviewed: [pr], assigned: [pr] }))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.role).toBe('reviewer')
  })
})

describe('Jira, sessions and ordering', () => {
  test('the Jira key comes from the title, then the branch', () => {
    expect(jiraKeyOf('fix: thing', 'ABC-123-forms')).toBe('ABC-123')
    expect(jiraKeyOf('ABC-1 x', 'ABC-2-y')).toBe('ABC-1')
    expect(jiraKeyOf('chore: deps', 'main')).toBeNull()
  })

  test('a Jira status on hold parks any PR, a blocked one blocks mine; priority orders a lane', () => {
    const issues = parseJiraIssues(
      JSON.stringify({
        data: {
          issues: [
            { key: 'ABC-1', fields: { summary: 'a', status: { name: 'On Hold' }, priority: { name: 'Low' } } },
            { key: 'ABC-2', fields: { summary: 'b', status: { name: 'In Progress' }, priority: { name: 'Highest' } } },
          ],
        },
      }),
    )
    const jira = Object.fromEntries(issues.map(issue => [issue.key, issue]))
    const held = applyJira(classify(rawPr({ title: 'ABC-1 a', ci: 'FAILURE' }), ME, 'author'), jira)
    expect(held).toMatchObject({ lane: 'onhold', reason: 'Jira “On Hold”' })
    expect(actionPrompt(held)).toBeNull()
    const theirs = applyJira(classify(rawPr({ title: 'ABC-1 a', author: 'bob', requested: [ME] }), ME, 'reviewer'), jira)
    expect(theirs.lane).toBe('onhold')
    const stuck = applyJira(classify(rawPr({ title: 'ABC-5 a', requested: ['bob'] }), ME, 'author'), {
      'ABC-5': { key: 'ABC-5', summary: '', status: 'Blocked', category: null, priority: null, assignee: null, type: null },
    })
    expect(stuck).toMatchObject({ lane: 'blocked', reason: 'Jira “Blocked”' })
    const low = classify(rawPr({ number: 1, title: 'ABC-3 low' }), ME, 'author')
    const high = classify(rawPr({ number: 2, title: 'ABC-2 high' }), ME, 'author')
    expect(sortPrs([low, high], jira).map(row => row.number)).toEqual([2, 1])
  })

  test('Jira issues are read from every answer shape of the connector', () => {
    const issue = { key: 'ABC-4', fields: { summary: 'd', status: { name: 'Review', statusCategory: { key: 'indeterminate' } }, priority: { name: 'Critical' } } }
    const expected = { key: 'ABC-4', summary: 'd', status: 'Review', category: 'indeterminate', priority: 'Critical', assignee: null, type: null }
    for (const body of [
      { issues: { nodes: [issue], pageInfo: { hasNextPage: false } } },
      { data: { issues: { nodes: [issue] } } },
      { issues: [issue] },
      { data: { issues: [issue] } },
    ]) {
      expect(parseJiraIssues(JSON.stringify(body))).toEqual([expected])
    }
    expect(parseJiraIssues(JSON.stringify({ issues: { nodes: [] } }))).toEqual([])
    expect(parseJiraIssues(JSON.stringify({}))).toEqual([])
  })

  test('a Jira answer without a list of issues is refused', () => {
    expect(() => parseJiraIssues(JSON.stringify({ issues: {} }))).toThrow('the Jira answer holds no list of issues')
    expect(() => parseJiraIssues(JSON.stringify({ issues: 'none' }))).toThrow('the Jira answer holds no list of issues')
  })

  test('only issues really in progress and without a PR are listed alone', () => {
    const info = (key: string, status: string) => ({ key, summary: key, status, category: 'indeterminate', priority: null, assignee: null, type: null })
    expect(isWorkingStatus('In Progress')).toBe(true)
    expect(isWorkingStatus('Final Approval')).toBe(false)
    expect(isWorkingStatus('Code Review')).toBe(false)
    const snapshot: Snapshot = {
      fetchedAt: 0, login: ME, prs: [classify(rawPr({ title: 'ABC-1 a' }), ME, 'author')], jira: {},
      jiraInProgress: [info('ABC-1', 'In Progress'), info('ABC-2', 'In Progress'), info('ABC-3', 'Final Approval')],
      jiraSite: null, jiraState: 'ok', sessions: [], sessionsState: 'ok', runs: [], errors: [],
    }
    expect(lonelyIssues(snapshot).map(issue => issue.key)).toEqual(['ABC-2'])
  })

  test('sessions link by PR number in the same repository, or by Jira key', () => {
    const row = classify(rawPr({ number: 9, title: 'ABC-9 x' }), ME, 'author')
    const sessions = parseSessions(
      JSON.stringify([
        { sessionId: 'a', title: 'other', cwd: 'C:/a', prNumber: 9, lastActivityAt: '' },
        { sessionId: 'b', title: 'ABC-9 chain', cwd: 'C:/b', lastActivityAt: '' },
        { sessionId: 'c', title: 'old', cwd: 'C:/a', prNumber: 9, isArchived: true },
      ]),
    ).map(s => ({ ...s, repo: s.cwd === 'C:/a' ? 'Acme/App' : null }))
    expect(sessionsOf(row, sessions).map(s => s.id)).toEqual(['a', 'b'])
    expect(repoOfRemote('https://github.com/Acme/Widgets.git\n')).toBe('Acme/Widgets')
    expect(repoOfRemote('git@github.com:acme/agent-tools.git')).toBe('acme/agent-tools')
  })

  test('the status line and the toasts only speak of what changed', () => {
    const blocked = classify(rawPr({ number: 1, mergeable: 'CONFLICTING' }), ME, 'author')
    const waiting = classify(rawPr({ number: 2, author: 'bob', requested: ['carol'] }), ME, 'reviewer')
    const snapshot = (prs: typeof blocked[]): Snapshot => ({
      fetchedAt: 0, login: ME, prs, jira: {}, jiraInProgress: [], jiraSite: null, jiraState: 'ok',
      sessions: [], sessionsState: 'ok', runs: [], errors: [],
    })
    expect(statusText(snapshot([blocked, waiting]))).toBe('PR ✖ 1 ◷ 1')
    expect(statusText(snapshot([]))).toBeUndefined()
    expect(newlyUrgent(snapshot([waiting]), snapshot([blocked, waiting])).map(row => row.number)).toEqual([1])
    expect(newlyUrgent(null, snapshot([blocked]))).toEqual([])
    expect(actionPrompt(classify(rawPr({ ci: 'FAILURE' }), ME, 'author'))?.label).toBe('Start the review')
    expect(actionPrompt(waiting)?.label).toBe('Resume')
  })
})

describe('the GitHub budget', () => {
  test('the PR ids are asked first, once each, and only those found get details', () => {
    const mine = rawPr({ number: 1 })
    const theirs = rawPr({ number: 2, author: 'bob', requested: [ME] })
    const ids = {
      viewer: { login: ME },
      authored: { nodes: [{ id: mine.id }] },
      requested: { nodes: [{ id: theirs.id }, {}] },
      reviewed: { nodes: [{ id: mine.id }] },
      assigned: { nodes: [] },
    }
    expect(idsOf(ids)).toEqual(['PR_1', 'PR_2'])
    expect(idsOf({ ...ids, authored: { nodes: [] }, requested: { nodes: [] }, reviewed: { nodes: [] } })).toEqual([])
    const rows = collectPrs(withDetails(ids, [theirs, null]))
    expect(rows.map(row => row.number)).toEqual([2])
    expect(collectPrs(withDetails(ids, [mine, theirs]))).toEqual(collectPrs(search({ authored: [mine], requested: [theirs], reviewed: [mine] })))
  })

  test('a rate limit is told apart and its note says when the radar asks again', () => {
    expect(isRateLimited('gh api graphql: gh: API rate limit exceeded for user ID 1.')).toBe(true)
    expect(isRateLimited('gh api graphql: HTTP 502')).toBe(false)
    expect(pauseNote(0, 90_000, true)).toBe('GitHub: API rate limit reached; the radar asks again in 2 min')
    expect(pauseNote(0, 10, false)).toBe('GitHub: API budget low; automatic refreshes wait 1 min')
  })
})
