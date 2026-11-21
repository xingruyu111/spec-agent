import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type Database } from '@spec-agent/core';
import { createSystemClock } from '@spec-agent/kernel';
import { WorkService } from '../../apps/server/src/work/work-service.js';
import { WorkStore } from '../../apps/server/src/work/work-store.js';

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function setup(): { store: WorkStore; service: WorkService } {
  const db = openDatabase(':memory:');
  migrate(db, createSystemClock());
  databases.push(db);
  const store = new WorkStore(db, createSystemClock());
  return { store, service: new WorkService(store) };
}

describe('WorkService', () => {
  it('群聊无 @ 路由给助理，有 @ 路由给指定 Agent', () => {
    const { store, service } = setup();
    const group = store.createGroup({ projectId: 'p1', name: '#前端' });

    const plain = service.intakeGroupMessage({
      groupId: group.id,
      author: { type: 'user', id: 'u1' },
      content: '登录页要支持邮箱',
    });
    expect(plain.recipients).toEqual(['assistant']);
    expect(plain.requiresAssistant).toBe(true);

    const mentioned = service.intakeGroupMessage({
      groupId: group.id,
      author: { type: 'user', id: 'u1' },
      content: '看下这个报错',
      mentions: ['fe'],
    });
    expect(mentioned.recipients).toEqual(['fe']);
    expect(mentioned.requiresAssistant).toBe(false);
  });

  it('Work Item 完成后产生 report 事件并 @ 发起人', () => {
    const { store, service } = setup();
    const group = store.createGroup({ projectId: 'p1', name: '#前端' });
    const intake = service.intakeGroupMessage({
      groupId: group.id,
      author: { type: 'user', id: 'u1' },
      content: '把按钮改成蓝色',
      mentions: ['fe'],
    });
    const opened = service.openWorkItem({
      groupId: group.id,
      eventId: intake.event.id,
      requestedBy: { type: 'user', id: 'u1' },
      title: '按钮蓝色',
      assignee: 'fe',
    });
    expect(opened.assignment?.state).toBe('queued');

    service.startAssignment(opened.assignment!.id, 'run-1');
    const result = service.reportAssignment({
      assignmentId: opened.assignment!.id,
      kind: 'done',
      summary: '已完成',
      artifacts: [{ path: 'web/button.css' }],
    });

    expect(result.workItem.state).toBe('done');
    expect(result.assignment.state).toBe('done');
    expect(result.event.type).toBe('assignment.reported');
    expect(result.event.payload.mention).toBe('u1');
    expect(result.report.artifacts).toEqual([{ path: 'web/button.css' }]);
  });

  it('dedupeKey 重复事件只落一条', () => {
    const { store, service } = setup();
    const group = store.createGroup({ projectId: 'p1', name: '#前端' });
    const first = service.intakeGroupMessage({
      groupId: group.id,
      author: { type: 'user', id: 'u1' },
      content: '同一条',
      dedupeKey: 'same-event',
    });
    const second = service.intakeGroupMessage({
      groupId: group.id,
      author: { type: 'user', id: 'u1' },
      content: '同一条',
      dedupeKey: 'same-event',
    });
    expect(second.event.id).toBe(first.event.id);
    expect(store.listEvents(group.id)).toHaveLength(2);
  });

  it('启动恢复把 running 退回 queued', () => {
    const { store, service } = setup();
    const group = store.createGroup({ projectId: 'p1', name: '#恢复' });
    const intake = service.intakeGroupMessage({
      groupId: group.id,
      author: { type: 'user', id: 'u1' },
      content: '崩溃恢复',
    });
    const opened = service.openWorkItem({
      groupId: group.id,
      eventId: intake.event.id,
      requestedBy: { type: 'user', id: 'u1' },
      title: '崩溃恢复',
      assignee: 'assistant',
    });
    service.startAssignment(opened.assignment!.id);
    expect(store.getAssignment(opened.assignment!.id)?.state).toBe('running');

    const recovered = service.recoverRunning();
    expect(recovered.count).toBe(1);
    expect(store.getAssignment(opened.assignment!.id)?.state).toBe('queued');
    expect(store.getWorkItem(opened.item.id)?.state).toBe('ready');
  });

  it('queued Assignment 按 Work Item priority 降序', () => {
    const { store, service } = setup();
    const group = store.createGroup({ projectId: 'p1', name: '#priority' });
    const first = service.intakeGroupMessage({
      groupId: group.id,
      author: { type: 'user', id: 'u1' },
      content: '低优先级',
    });
    const low = service.openWorkItem({
      groupId: group.id,
      eventId: first.event.id,
      requestedBy: { type: 'user', id: 'u1' },
      title: '低优先级',
      assignee: 'assistant',
      priority: 0,
    });
    const second = service.intakeGroupMessage({
      groupId: group.id,
      author: { type: 'user', id: 'u1' },
      content: '高优先级',
    });
    const high = service.openWorkItem({
      groupId: group.id,
      eventId: second.event.id,
      requestedBy: { type: 'user', id: 'u1' },
      title: '高优先级',
      assignee: 'assistant',
      priority: 2,
    });
    const queued = service.queuedAssignments('p1');
    expect(queued[0]?.id).toBe(high.assignment!.id);
    expect(queued[1]?.id).toBe(low.assignment!.id);
  });
});
