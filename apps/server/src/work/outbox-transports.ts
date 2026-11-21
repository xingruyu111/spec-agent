import type { WorkOutboxRow } from './work-store.js';

export type OutboxTransport = {
  name: string;
  send(row: WorkOutboxRow): Promise<void>;
};

class HttpOutboxTransport implements OutboxTransport {
  readonly name = 'http';

  constructor(
    private readonly url: string,
    private readonly token?: string,
  ) {}

  async send(row: WorkOutboxRow): Promise<void> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({
        source: row.source,
        externalId: row.externalId,
        kind: row.kind,
        payload: row.payload,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`outbox transport ${response.status}`);
    }
  }
}

class LogOutboxTransport implements OutboxTransport {
  readonly name = 'log';

  async send(row: WorkOutboxRow): Promise<void> {
    console.log(
      `[outbox:log] ${row.source}/${row.externalId ?? '-'} ${JSON.stringify(row.payload)}`,
    );
  }
}

export class GitHubCommentTransport implements OutboxTransport {
  readonly name = 'github';

  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apiBase = 'https://api.github.com',
  ) {}

  async send(row: WorkOutboxRow): Promise<void> {
    const rawUrl = row.payload.url;
    if (typeof rawUrl !== 'string') {
      throw new Error('GitHub 回执缺少来源 URL');
    }
    const issue = parseGitHubIssueUrl(rawUrl);
    if (!issue) throw new Error(`无法解析 GitHub issue URL：${rawUrl}`);
    const body = row.payload.body;
    if (typeof body !== 'string' || !body.trim()) {
      throw new Error('GitHub 回执正文为空');
    }
    const reviewCommentId = parseReviewCommentId(rawUrl);
    const endpoint = reviewCommentId
      ? `${this.apiBase}/repos/${issue.owner}/${issue.repo}/pulls/${issue.number}/comments`
      : `${this.apiBase}/repos/${issue.owner}/${issue.repo}/issues/${issue.number}/comments`;
    const response = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.token}`,
        'user-agent': 'spec-agent-outbox',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        body,
        ...(reviewCommentId ? { in_reply_to: reviewCommentId } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `GitHub comment failed: ${response.status}${
          detail ? ` ${detail.slice(0, 300)}` : ''
        }`,
      );
    }
  }
}

export function parseReviewCommentId(rawUrl: string): number | null {
  const match = /#discussion_r(\d+)/.exec(rawUrl);
  return match ? Number(match[1]) : null;
}

export function parseGitHubIssueUrl(
  rawUrl: string,
): { owner: string; repo: string; number: number } | null {
  try {
    const url = new URL(rawUrl);
    if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') {
      return null;
    }
    const match =
      /^\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)(?:\/|$)/.exec(url.pathname);
    if (!match) return null;
    return {
      owner: match[1]!,
      repo: match[2]!,
      number: Number(match[3]),
    };
  } catch {
    return null;
  }
}

export function createOutboxTransport(
  env: NodeJS.ProcessEnv = process.env,
): OutboxTransport | undefined {
  if (env.SPEC_AGENT_OUTBOX_URL) {
    return new HttpOutboxTransport(
      env.SPEC_AGENT_OUTBOX_URL,
      env.SPEC_AGENT_OUTBOX_TOKEN,
    );
  }
  if (env.SPEC_AGENT_OUTBOX_TRANSPORT === 'github' && env.GITHUB_TOKEN) {
    return new GitHubCommentTransport(
      env.GITHUB_TOKEN,
      fetch,
      env.GITHUB_API_BASE ?? 'https://api.github.com',
    );
  }
  if (env.SPEC_AGENT_OUTBOX_TRANSPORT === 'log') {
    return new LogOutboxTransport();
  }
  return undefined;
}

