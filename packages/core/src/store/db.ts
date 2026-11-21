/**
 * SQLite 连接。
 *
 * 用 node:sqlite（Node 24 内置），不引原生模块，Windows 上不用编译。
 * 单写者模型：一个进程持有写连接，读走同一连接足够。
 */

import { DatabaseSync } from 'node:sqlite';

export type Database = DatabaseSync;

export function openDatabase(path: string): Database {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');
  return db;
}

export type TxOptions = { immediate?: boolean };

/** 同步事务包装。回调是同步的——node:sqlite 没有异步 API。 */
export function transaction<T>(db: Database, fn: () => T, options: TxOptions = {}): T {
  const begin = options.immediate === false ? 'BEGIN' : 'BEGIN IMMEDIATE';
  db.exec(begin);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 连接已断时 rollback 会失败，不能盖住原始错误
    }
    throw error;
  }
}
