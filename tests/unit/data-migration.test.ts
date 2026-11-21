import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '@spec-agent/core';
import { createRuntime } from '@spec-agent/runtime';
import { migrateLegacyProjectData } from '../../packages/runtime/src/data-migration.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'spec-agent-migration-'));
  roots.push(root);
  return root;
}

describe('Legacy project data migration', () => {
  it('迁移 .hive/hive.db、WAL 和 agents 配置到 .spec-agent', () => {
    const root = temp();
    mkdirSync(join(root, '.hive', 'dsh'), { recursive: true });
    writeFileSync(join(root, '.hive', 'hive.db'), 'database');
    writeFileSync(join(root, '.hive', 'hive.db-wal'), 'wal');
    writeFileSync(join(root, '.hive', 'agents.yaml'), 'agents: []');
    writeFileSync(join(root, '.hive', 'dsh', 'session.json'), '{}');

    expect(migrateLegacyProjectData(root)).toBe(true);
    expect(existsSync(join(root, '.hive'))).toBe(false);
    expect(readFileSync(join(root, '.spec-agent', 'spec-agent.db'), 'utf8')).toBe('database');
    expect(readFileSync(join(root, '.spec-agent', 'spec-agent.db-wal'), 'utf8')).toBe('wal');
    expect(readFileSync(join(root, '.spec-agent', 'agents.yaml'), 'utf8')).toBe('agents: []');
    expect(existsSync(join(root, '.spec-agent', 'dsh', 'session.json'))).toBe(true);
  });

  it('已有 Spec Agent 数据库优先，不被旧库覆盖', () => {
    const root = temp();
    mkdirSync(join(root, '.hive'), { recursive: true });
    mkdirSync(join(root, '.spec-agent'), { recursive: true });
    writeFileSync(join(root, '.hive', 'hive.db'), 'old');
    writeFileSync(join(root, '.spec-agent', 'spec-agent.db'), 'new');
    migrateLegacyProjectData(root);
    expect(readFileSync(join(root, '.spec-agent', 'spec-agent.db'), 'utf8')).toBe('new');
    expect(readFileSync(join(root, '.hive', 'hive.db'), 'utf8')).toBe('old');
  });

  it('createRuntime 自动迁移并打开现有数据库', () => {
    const root = temp();
    mkdirSync(join(root, '.hive'), { recursive: true });
    const legacy = new Store({ path: join(root, '.hive', 'hive.db') });
    legacy.close();

    const runtime = createRuntime({ root });
    expect(existsSync(join(root, '.spec-agent', 'spec-agent.db'))).toBe(true);
    expect(existsSync(join(root, '.hive'))).toBe(false);
    expect(runtime.store.listTasks()).toEqual([]);
    runtime.close();
  });
});
