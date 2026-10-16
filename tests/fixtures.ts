import type { RawPr, RawSearch } from '../hooks/model'

export const ME = 'me'

type Review = { author: string; state: string; submittedAt: string }

export const rawPr = (
  over: Partial<Omit<RawPr, 'author' | 'reviewRequests' | 'latestOpinionatedReviews' | 'latestReviews' | 'reviewThreads' | 'commits' | 'labels'>> & {
    author?: string
    requested?: string[]
    reviews?: Review[]
    threads?: { isResolved?: boolean; isOutdated?: boolean; last: string }[]
    lastCommitAt?: string
    ci?: string | null
    labels?: string[]
  } = {},
): RawPr => {
  const reviews = (over.reviews ?? []).map(r => ({ author: { login: r.author }, state: r.state, submittedAt: r.submittedAt }))
  return {
    id: over.id ?? `PR_${over.number ?? 1}`,
    number: over.number ?? 1,
    title: over.title ?? 'ABC-100 Fix the widget',
    url: over.url ?? `https://github.com/acme/app/pull/${over.number ?? 1}`,
    isDraft: over.isDraft ?? false,
    createdAt: over.createdAt ?? '2026-10-01T10:00:00Z',
    updatedAt: over.updatedAt ?? '2026-10-10T10:00:00Z',
    headRefName: over.headRefName ?? 'ABC-100-fix-widget',
    baseRefName: over.baseRefName ?? 'main',
    additions: over.additions ?? 10,
    deletions: over.deletions ?? 2,
    repository: over.repository ?? { nameWithOwner: 'acme/app' },
    author: { login: over.author ?? ME },
    reviewDecision: over.reviewDecision ?? null,
    mergeable: over.mergeable ?? 'MERGEABLE',
    labels: { nodes: (over.labels ?? []).map(name => ({ name })) },
    reviewRequests: { nodes: (over.requested ?? []).map(login => ({ requestedReviewer: { login } })) },
    latestOpinionatedReviews: { nodes: reviews.filter(r => r.state !== 'COMMENTED') },
    latestReviews: { nodes: reviews },
    reviewThreads: {
      nodes: (over.threads ?? []).map(t => ({
        isResolved: t.isResolved ?? false,
        isOutdated: t.isOutdated ?? false,
        comments: { nodes: [{ author: { login: t.last } }] },
      })),
    },
    commits: {
      nodes: [
        {
          commit: {
            committedDate: over.lastCommitAt ?? '2026-10-05T10:00:00Z',
            statusCheckRollup: over.ci === null ? null : { state: over.ci ?? 'SUCCESS' },
          },
        },
      ],
    },
  }
}

export const search = (parts: Partial<Record<'authored' | 'requested' | 'reviewed' | 'assigned', RawPr[]>>): RawSearch => ({
  viewer: { login: ME },
  authored: { nodes: parts.authored ?? [] },
  requested: { nodes: parts.requested ?? [] },
  reviewed: { nodes: parts.reviewed ?? [] },
  assigned: { nodes: parts.assigned ?? [] },
})
