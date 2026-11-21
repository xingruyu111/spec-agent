import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '@spec-agent/core';
import { OutboxWorker, GitHubCommentTransport, parseGitHubIssueUrl, parseReviewCommentId, type OutboxTransport } from '../../apps/server/src/work/outbox-worker.js';
import { WorkService } from '../../apps/server/src/work/work-service.js';
import { WorkStore } from '../../apps/server/src/work/work-store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('OutboxWorker', () => {
  it('发送成功标记 sent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spec-agent-outbox-'));
    dirs.push(dir);
    const store = new Store({ path: join(dir, 'db.sqlite') });
    try {
      const workStore = new WorkStore(store.db, store.clock);
      const work = new WorkService(workStore);
      workStore.enqueueOutbox({
        projectId: 'p1',
        source: 'github',
        externalId: 'issue-1',
        workItemId: 'wi-1',
        kind: 'comment',
        payload: { body: 'done' },
      });
      const sent: string[] = [];
      const transport: OutboxTransport = {
        name: 'test',
        async send(row) {
          sent.push(row.externalId ?? '');
        },
      };
      const worker = new OutboxWorker({ work, projectId: 'p1', transport });
      const result = await worker.runOnce();
      expect(result.sent).toBe(1);
      expect(sent).toEqual(['issue-1']);
      expect(work.outbox('p1')[0]?.status).toBe('sent');
    } finally {
      store.close();
    }
  });

  it('失败累加 attempts 并设置退避', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spec-agent-outbox-fail-'));
    dirs.push(dir);
    const store = new Store({ path: join(dir, 'db.sqlite') });
    try {
      const workStore = new WorkStore(store.db, store.clock);
      const work = new WorkService(workStore);
      workStore.enqueueOutbox({
        projectId: 'p1',
        source: 'github',
        externalId: 'issue-2',
        workItemId: 'wi-2',
        kind: 'comment',
        payload: { body: 'done' },
      });
      const transport: OutboxTransport = {
        name: 'fail',
        async send() {
          throw new Error('network down');
        },
      };
      const worker = new OutboxWorker({ work, projectId: 'p1', transport });
      await worker.runOnce();
      const row = work.outbox('p1')[0];
      expect(row?.status).toBe('pending');
      expect(row?.attempts).toBe(1);
      expect(row?.lastError).toContain('network down');
      expect(row?.nextAttemptAt).toBeTruthy();
    } finally {
      store.close();
    }
  });

  it('解析 GitHub URL 并调用 Comments API', async () => {
    expect(parseGitHubIssueUrl('https://github.com/acme/app/issues/42')).toEqual({
      owner: 'acme',
      repo: 'app',
      number: 42,
    });
    expect(
      parseGitHubIssueUrl('https://github.com/acme/app/pull/7/files'),
    ).toEqual({ owner: 'acme', repo: 'app', number: 7 });
    expect(parseGitHubIssueUrl('https://example.com/acme/app/issues/1')).toBeNull();

    let calledUrl = '';
    let calledInit: RequestInit | undefined;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calledUrl = String(url);
      calledInit = init;
      return new Response('{}', { status: 201 });
    }) as typeof fetch;
    const transport = new GitHubCommentTransport(
      'token-1',
      fakeFetch,
      'https://api.github.test',
    );
    await transport.send({
      id: 'o1',
      projectId: 'p1',
      groupId: null,
      workItemId: 'wi-1',
      source: 'github',
      externalId: 'issue-1',
      kind: 'comment',
      payload: {
        url: 'https://github.com/acme/app/issues/42',
        body: '已完成',
      },
      status: 'pending',
      attempts: 0,
      maxAttempts: 3,
      lastError: null,
      nextAttemptAt: null,
      createdAt: '',
      updatedAt: '',
    });
    expect(calledUrl).toBe(
      'https://api.github.test/repos/acme/app/issues/42/comments',
    );
    expect((calledInit?.headers as Record<string, string>).authorization).toBe(
      'Bearer token-1',
    );
    expect(calledInit?.body).toBe(JSON.stringify({ body: '已完成' }));
  });

  it('runOne 只发送指定回执', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spec-agent-outbox-one-'));
    dirs.push(dir);
    const store = new Store({ path: join(dir, 'db.sqlite') });
    try {
      const workStore = new WorkStore(store.db, store.clock);
      const work = new WorkService(workStore);
      const first = workStore.enqueueOutbox({
        projectId: 'p1',
        groupId: 'g1',
        source: 'github',
        externalId: 'one-1',
        workItemId: 'wi-1',
        kind: 'comment',
        payload: { body: 'one' },
      });
      workStore.enqueueOutbox({
        projectId: 'p1',
        source: 'github',
        externalId: 'one-2',
        workItemId: 'wi-2',
        kind: 'comment',
        payload: { body: 'two' },
      });
      const sent: string[] = [];
      const worker = new OutboxWorker({
        work,
        projectId: 'p1',
        transport: {
          name: 'test',
          async send(row) {
            sent.push(row.externalId ?? '');
          },
        },
      });
      const result = await worker.runOne(first.id);
      expect(result.outbox?.status).toBe('sent');
      expect(sent).toEqual(['one-1']);
      expect(work.outboxAttempts(first.id)).toHaveLength(1);
      expect(work.outboxAttempts(first.id)[0]?.ok).toBe(true);
      expect(work.outboxAudit('p1')[0]?.externalId).toBe('one-1');
      expect(
        workStore
          .listEvents('g1')
          .some((event) => event.type === 'outbox.sent'),
      ).toBe(true);
      expect(work.outbox('p1').filter((row) => row.status === 'pending')).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('GitHub 403 错误保留响应正文', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ message: 'Bad credentials' }), {
        status: 403,
      })) as typeof fetch;
    const transport = new GitHubCommentTransport(
      'bad-token',
      fakeFetch,
      'https://api.github.test',
    );
    await expect(
      transport.send({
        id: 'o3',
        projectId: 'p1',
        groupId: null,
        workItemId: 'wi-3',
        source: 'github',
        externalId: 'issue-3',
        kind: 'comment',
        payload: {
          url: 'https://github.com/acme/app/issues/42',
          body: '已完成',
        },
        status: 'pending',
        attempts: 0,
        maxAttempts: 3,
        lastError: null,
        nextAttemptAt: null,
        createdAt: '',
        updatedAt: '',
      }),
    ).rejects.toThrow('403');
    await expect(
      transport.send({
        id: 'o3',
        projectId: 'p1',
        groupId: null,
        workItemId: 'wi-3',
        source: 'github',
        externalId: 'issue-3',
        kind: 'comment',
        payload: {
          url: 'https://github.com/acme/app/issues/42',
          body: '已完成',
        },
        status: 'pending',
        attempts: 0,
        maxAttempts: 3,
        lastError: null,
        nextAttemptAt: null,
        createdAt: '',
        updatedAt: '',
      }),
    ).rejects.toThrow('Bad credentials');
  });

  it('review comment 使用 in_reply_to 回复 PR thread', async () => {    expect(
      parseReviewCommentId('https://github.com/acme/app/pull/5#discussion_r301'),
    ).toBe(301);
    let calledUrl = '';
    let calledBody = '';
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calledUrl = String(url);
      calledBody = String(init?.body ?? '');
      return new Response('{}', { status: 201 });
    }) as typeof fetch;
    const transport = new GitHubCommentTransport(
      'token-1',
      fakeFetch,
      'https://api.github.test',
    );
    await transport.send({
      id: 'o2',
      projectId: 'p1',
      groupId: null,
      workItemId: 'wi-2',
      source: 'github',
      externalId: 'review-comment:301',
      kind: 'comment',
      payload: {
        url: 'https://github.com/acme/app/pull/5#discussion_r301',
        body: '已处理空值。',
      },
      status: 'pending',
      attempts: 0,
      maxAttempts: 3,
      lastError: null,
      nextAttemptAt: null,
      createdAt: '',
      updatedAt: '',
    });
    expect(calledUrl).toBe(
      'https://api.github.test/repos/acme/app/pulls/5/comments',
    );
    expect(JSON.parse(calledBody)).toEqual({
      body: '已处理空值。',
      in_reply_to: 301,
    });
  });
});
