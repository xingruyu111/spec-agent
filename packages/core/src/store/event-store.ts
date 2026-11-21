/**
 * 事件存储。
 *
 * 追加是原子的：事件行与投影在同一个事务里写入。
 * 要么全成功，要么什么都没发生——这是"事件日志是唯一真相"的前提。
 */

import type { AnyEvent } from '@spec-agent/schema';
import { AppError, isAppError } from '@spec-agent/kernel';
import type { Database } from './db.js';
import { transaction } from './db.js';
import type { Projector } from './projector.js';

/** 只在联合类型上做 Omit，保留判别字段的窄化能力。 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** 待写入的事件：seq 由数据库分配。 */
export type NewEvent = DistributiveOmit<AnyEvent, 'seq'>;

export type AppendOptions = {
  /** 乐观并发：与当前最大 seq 不一致时拒绝写入 */
  expectedSeq?: number;
};

export type EventFilter = {
  taskId?: string;
  runId?: string;
  nodeRunId?: string;
  afterSeq?: number;
  limit?: number;
};

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

type EventRow = {
  seq: number;
  id: string;
  ts: string;
  type: string;
  v: number;
  actor_type: string;
  actor_id: string | null;
  task_id: string | null;
  run_id: string | null;
  node_run_id: string | null;
  correlation_id: string;
  causation_id: string | null;
  payload: string;
};

export class EventStore {
  constructor(
    private readonly db: Database,
    private readonly projector: Projector,
  ) {}

  append(events: NewEvent[], options: AppendOptions = {}): number[] {
    if (events.length === 0) return [];

    try {
      return transaction(this.db, () => {
        if (options.expectedSeq !== undefined) {
          const current = this.lastSeq();
          if (current !== options.expectedSeq) {
            throw new AppError(
              'E_EVENT_SEQ_CONFLICT',
              `期望 seq ${options.expectedSeq}，实际 ${current}`,
            );
          }
        }

        const insert = this.db.prepare(
          `INSERT INTO events
            (id, ts, type, v, actor_type, actor_id, task_id, run_id, node_run_id,
             correlation_id, causation_id, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );

        const seqs: number[] = [];
        for (const event of events) {
          const result = insert.run(
            event.id,
            event.ts,
            event.type,
            event.v,
            event.actor.type,
            event.actor.id,
            event.taskId ?? null,
            event.runId ?? null,
            event.nodeRunId ?? null,
            event.correlationId,
            event.causationId ?? null,
            JSON.stringify(event.payload ?? null),
          );
          const seq = Number(result.lastInsertRowid);
          seqs.push(seq);
          this.projector.apply(this.db, { ...event, seq } as AnyEvent);
        }
        return seqs;
      });
    } catch (error) {
      if (isAppError(error)) throw error;
      throw new AppError('E_EVENT_APPEND', '写入事件失败', { cause: error });
    }
  }

  read(filter: EventFilter = {}): AnyEvent[] {
    const where: string[] = [];
    const params: Array<string | number> = [];

    if (filter.taskId) {
      where.push('task_id = ?');
      params.push(filter.taskId);
    }
    if (filter.runId) {
      where.push('run_id = ?');
      params.push(filter.runId);
    }
    if (filter.nodeRunId) {
      where.push('node_run_id = ?');
      params.push(filter.nodeRunId);
    }
    if (filter.afterSeq !== undefined) {
      where.push('seq > ?');
      params.push(filter.afterSeq);
    }

    const limit = Math.min(Math.max(1, filter.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    const sql = `SELECT * FROM events ${
      where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    } ORDER BY seq ASC LIMIT ?`;

    const rows = this.db.prepare(sql).all(...params, limit) as EventRow[];
    return rows.map(toEvent);
  }

  lastSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as {
      seq: number;
    };
    return Number(row.seq);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    return Number(row.n);
  }
}

function toEvent(row: EventRow): AnyEvent {
  return {
    seq: Number(row.seq),
    id: row.id,
    ts: row.ts,
    type: row.type,
    v: Number(row.v),
    actor: { type: row.actor_type, id: row.actor_id ?? '' },
    correlationId: row.correlation_id,
    payload: JSON.parse(row.payload),
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.node_run_id ? { nodeRunId: row.node_run_id } : {}),
    ...(row.causation_id ? { causationId: row.causation_id } : {}),
  } as AnyEvent;
}
