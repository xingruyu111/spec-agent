/** Legacy Hive project data → Spec Agent data migration. */

import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';

export const SPEC_AGENT_DATA_DIR = '.spec-agent';
export const SPEC_AGENT_DB_FILE = 'spec-agent.db';

export function specAgentDataPath(root: string): string {
  return join(root, SPEC_AGENT_DATA_DIR);
}

/**
 * 旧项目首次启动时迁移 .hive/hive.db。
 * 完整目录可直接 rename；两个目录都存在时只补缺，不覆盖新数据。
 */
export function migrateLegacyProjectData(root: string): boolean {
  const legacy = join(root, '.hive');
  const current = specAgentDataPath(root);
  if (!existsSync(legacy)) {
    return renameLegacyDbInsideCurrent(current);
  }
  if (!existsSync(current)) {
    renameSync(legacy, current);
    renameLegacyDbInsideCurrent(current);
    return true;
  }

  mkdirSync(current, { recursive: true });
  let changed = renameLegacyDbInsideCurrent(current);
  for (const suffix of ['', '-wal', '-shm']) {
    const from = join(legacy, `hive.db${suffix}`);
    const to = join(current, `${SPEC_AGENT_DB_FILE}${suffix}`);
    if (existsSync(from) && !existsSync(to)) {
      renameSync(from, to);
      changed = true;
    }
  }
  for (const file of ['agents.yaml', 'settings.json']) {
    const from = join(legacy, file);
    const to = join(current, file);
    if (existsSync(from) && !existsSync(to)) {
      copyFileSync(from, to, constants.COPYFILE_EXCL);
      changed = true;
    }
  }
  for (const directory of ['dsh', 'skills']) {
    const from = join(legacy, directory);
    const to = join(current, directory);
    if (existsSync(from) && !existsSync(to)) {
      renameSync(from, to);
      changed = true;
    }
  }
  return changed;
}

function renameLegacyDbInsideCurrent(current: string): boolean {
  const legacyDb = join(current, 'hive.db');
  const currentDb = join(current, SPEC_AGENT_DB_FILE);
  if (!existsSync(legacyDb) || existsSync(currentDb)) return false;
  renameSync(legacyDb, currentDb);
  for (const suffix of ['-wal', '-shm']) {
    const from = `${legacyDb}${suffix}`;
    const to = `${currentDb}${suffix}`;
    if (existsSync(from) && !existsSync(to)) renameSync(from, to);
  }
  return true;
}
