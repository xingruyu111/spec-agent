/**
 * GitHub Webhook 归一化。
 * 支持 issues / issue_comment / pull_request 原生 payload；
 * 无法识别时回退到简化字段，兼容现有调用方。
 */

export type NormalizedSourceEvent = {
  externalId: string;
  title: string;
  body: string;
  url: string;
  event?:
    | 'issues'
    | 'issue_comment'
    | 'pull_request'
    | 'pull_request_review_comment'
    | 'pull_request_review';
  action?: string;
  labels: string[];
  author?: string;
};

export function normalizeGitHubPayload(
  payload: Record<string, unknown>,
): NormalizedSourceEvent | null {
  const issue = asRecord(payload.issue);
  const comment = asRecord(payload.comment);
  const pull = asRecord(payload.pull_request);
  const review = asRecord(payload.review);
  const repo = asRecord(payload.repository);
  const repoName =
    typeof repo?.full_name === 'string'
      ? repo.full_name
      : typeof payload.repository === 'string'
        ? payload.repository
        : 'unknown';
  const action = typeof payload.action === 'string' ? payload.action : undefined;
  const labels = labelsOf(issue ?? pull);
  const author =
    loginOf(comment?.user) ??
    loginOf(review?.user) ??
    loginOf((issue ?? pull)?.user) ??
    loginOf(payload.sender);

  if (comment && pull && !issue) {
    const id = comment.id ?? payload.comment;
    return {
      externalId: `review-comment:${String(id)}`,
      title: `[PR 评论] ${str(pull.title) ?? `#${String(pull.number ?? '')}`}`,
      body: str(comment.body) ?? '',
      url: str(comment.html_url) ?? str(pull.html_url) ?? '',
      event: 'pull_request_review_comment',
      ...(action ? { action } : {}),
      labels,
      ...(author ? { author } : {}),
    };
  }

  if (review && pull) {
    const id = review.id ?? payload.review;
    return {
      externalId: `review:${String(id)}`,
      title: `[PR Review] ${str(pull.title) ?? `#${String(pull.number ?? '')}`}`,
      body: str(review.body) ?? '',
      url: str(pull.html_url) ?? '',
      event: 'pull_request_review',
      ...(action ? { action } : {}),
      labels,
      ...(author ? { author } : {}),
    };
  }

  if (comment && issue) {
    const id = comment.id ?? payload.comment;
    const url = str(comment.html_url) ?? str(comment.url) ?? '';
    return {
      externalId: `comment:${String(id)}`,
      title: `[评论] ${str(issue.title) ?? `#${String(issue.number ?? '')}`}`,
      body: str(comment.body) ?? '',
      url,
      event: 'issue_comment',
      ...(action ? { action } : {}),
      labels,
      ...(author ? { author } : {}),
    };
  }

  const target = issue ?? pull;
  if (target) {
    const number = target.number;
    const updated =
      str(target.updated_at) ?? String(target.id ?? number ?? 'unknown');
    const url =
      str(target.html_url) ??
      str(target.url) ??
      `https://github.com/${repoName}/issues/${String(number ?? '')}`;
    return {
      externalId: `${issue ? 'issue' : 'pull'}:${repoName}#${String(number)}:${updated}`,
      title:
        str(target.title) ??
        `${issue ? 'Issue' : 'PR'} #${String(number ?? '')}`,
      body: str(target.body) ?? '',
      url,
      event: issue ? 'issues' : 'pull_request',
      ...(action ? { action } : {}),
      labels,
      ...(author ? { author } : {}),
    };
  }

  if (
    typeof payload.externalId === 'string' &&
    typeof payload.title === 'string'
  ) {
    return {
      externalId: payload.externalId,
      title: payload.title,
      body: str(payload.body) ?? '',
      url: str(payload.url) ?? '',
      ...(action ? { action } : {}),
      labels,
      ...(author ? { author } : {}),
    };
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function labelsOf(
  target: Record<string, unknown> | null | undefined,
): string[] {
  const raw = target?.labels;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((label) =>
      typeof label === 'string'
        ? label
        : typeof asRecord(label)?.name === 'string'
          ? String(asRecord(label)?.name)
          : null,
    )
    .filter((label): label is string => Boolean(label));
}

function loginOf(value: unknown): string | undefined {
  const user = asRecord(value);
  return typeof user?.login === 'string' ? user.login : undefined;
}

