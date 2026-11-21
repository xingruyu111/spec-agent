/**
 * 命令总线：engine 里唯一往事件表写东西的入口。
 *
 * 校验交给 domain；补信封（id / 时间 / actor）交给这里；两者都不碰 SQL。
 */

import type { Command, EventActor } from '@spec-agent/schema';
import { EVENT_SCHEMA_VERSION } from '@spec-agent/schema';
import type { Clock, IdFactory } from '@spec-agent/kernel';
import { decide, type AnyDraft, type DomainState } from '../domain/index.js';
import type { NewEvent } from '../store/event-store.js';
import type { Store } from '../store/store.js';
import { createDomainState } from './domain-state.js';

export class CommandBus {
  private readonly state: DomainState;

  constructor(
    private readonly store: Store,
    private readonly ids: IdFactory,
    private readonly clock: Clock,
    private readonly actor: EventActor,
  ) {
    this.state = createDomainState(store);
  }

  dispatch(command: Command): AnyDraft[] {
    const drafts = decide(command, this.state);
    const events = drafts.map((draft) => ({
      id: this.ids.event(),
      ts: this.clock.iso(),
      v: EVENT_SCHEMA_VERSION,
      actor: this.actor,
      correlationId: draft.taskId ?? 'system',
      ...draft,
    })) as NewEvent[];

    this.store.events.append(events);
    return drafts;
  }

  /** 追加不影响领域投影的观测事件（例如工具调用）。 */
  record(events: NewEvent[]): void {
    this.store.events.append(events);
  }
}
