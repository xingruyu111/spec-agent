import { describe, expect, it } from 'vitest';
import { normalizeGitHubPayload } from '../../apps/server/src/integrations/github-source.js';

describe('normalizeGitHubPayload', () => {
  it('归一化原生 issue payload', () => {
    const event = normalizeGitHubPayload({
      action: 'opened',
      repository: { full_name: 'acme/app' },
      issue: {
        id: 11,
        number: 42,
        title: '登录页报错',
        body: '点击登录后白屏',
        html_url: 'https://github.com/acme/app/issues/42',
        updated_at: '2026-11-18T10:00:00Z',
      },
    });
    expect(event).toEqual({
      externalId: 'issue:acme/app#42:2026-11-18T10:00:00Z',
      title: '登录页报错',
      body: '点击登录后白屏',
      url: 'https://github.com/acme/app/issues/42',
      event: 'issues',
      action: 'opened',
      labels: [],
    });
  });

  it('归一化 issue_comment payload', () => {
    const event = normalizeGitHubPayload({
      action: 'created',
      repository: { full_name: 'acme/app' },
      issue: { number: 42, title: '登录页报错' },
      comment: {
        id: 99,
        body: '我也可以复现',
        html_url: 'https://github.com/acme/app/issues/42#issuecomment-99',
      },
    });
    expect(event?.externalId).toBe('comment:99');
    expect(event?.title).toBe('[评论] 登录页报错');
    expect(event?.body).toBe('我也可以复现');
    expect(event?.event).toBe('issue_comment');
    expect(event?.action).toBe('created');
  });

  it('简化字段回退', () => {
    const event = normalizeGitHubPayload({
      externalId: 'issue-1',
      title: '简化标题',
      body: '内容',
    });
    expect(event?.externalId).toBe('issue-1');
    expect(event?.title).toBe('简化标题');
  });

  it('归一化 PR review comment 和 review', () => {
    const reviewComment = normalizeGitHubPayload({
      action: 'created',
      repository: { full_name: 'acme/app' },
      pull_request: { number: 5, title: '重构登录' },
      comment: {
        id: 301,
        body: '这里需要处理空值',
        html_url: 'https://github.com/acme/app/pull/5#discussion_r301',
      },
    });
    expect(reviewComment?.event).toBe('pull_request_review_comment');
    expect(reviewComment?.externalId).toBe('review-comment:301');
    expect(reviewComment?.title).toBe('[PR 评论] 重构登录');
    expect(reviewComment?.body).toBe('这里需要处理空值');

    const review = normalizeGitHubPayload({
      action: 'submitted',
      repository: { full_name: 'acme/app' },
      pull_request: { number: 5, title: '重构登录' },
      review: { id: 401, body: '整体可以，补一个测试' },
    });
    expect(review?.event).toBe('pull_request_review');
    expect(review?.externalId).toBe('review:401');
    expect(review?.title).toBe('[PR Review] 重构登录');
  });

  it('提取 issue labels 和作者', () => {
    const event = normalizeGitHubPayload({
      action: 'opened',
      repository: { full_name: 'acme/app' },
      issue: {
        number: 12,
        title: '带标签',
        html_url: 'https://github.com/acme/app/issues/12',
        updated_at: '2026-11-18T10:00:00Z',
        labels: [{ name: 'bug' }, { name: 'P1' }],
        user: { login: 'octocat' },
      },
    });
    expect(event?.labels).toEqual(['bug', 'P1']);
    expect(event?.author).toBe('octocat');
  });
});
