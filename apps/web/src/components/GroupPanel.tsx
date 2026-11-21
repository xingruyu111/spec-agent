import { useEffect, useState } from 'react';
import {
  api,
  type Agent,
  type WorkEvent,
} from '../api.js';
import { Markdown } from './Markdown';

type GroupPanelProps = {
  projectId: string;
  groupId: string;
  agents: Agent[];
  onError: (message: string) => void;
};

function eventText(
  event: WorkEvent,
  now = Date.now(),
): { label: string; text: string } | null {
  if (event.type === 'message.created') {
    if (
      event.actorId === 'assistant' &&
      String(event.payload.content ?? '').startsWith('已建工作项')
    ) {
      return null;
    }
    const content = String(event.payload.content ?? '').trim();
    if (!content) return null;
    return { label: event.actorId, text: content };
  }
  if (event.type === 'workitem.created') {
    return {
      label: 'Work Item',
      text: `创建：${String(event.payload.title ?? '')}`,
    };
  }
  if (event.type === 'assignment.started') {
    return {
      label: '开始执行',
      text: String(event.payload.agentId ?? event.actorId),
    };
  }
  if (event.type === 'assignment.progress') {
    return {
      label: '执行进度',
      text: String(event.payload.preview ?? event.payload.tool ?? ''),
    };
  }
  if (event.type === 'assignment.reported') {
    return {
      label: '执行报告',
      text: String(event.payload.summary ?? '').slice(0, 2000),
    };
  }
  if (event.type === 'outbox.pending') {
    const age = now - Date.parse(event.createdAt);
    return {
      label: 'GitHub 回执',
      text:
        age > 60_000
          ? `等待发送超过 1 分钟，请检查 GITHUB_TOKEN（${String(
              event.payload.externalId ?? '',
            )}）`
          : `排队中（${String(event.payload.externalId ?? '')}）`,
    };
  }
  if (event.type === 'outbox.sent') {
    return {
      label: 'GitHub 回执',
      text: `已发送（${String(event.payload.externalId ?? '')}）`,
    };
  }
  if (event.type === 'outbox.failed') {
    return {
      label: 'GitHub 回执',
      text: `发送失败：${String(event.payload.error ?? '')}`,
    };
  }
  return null;
}

/** 群聊主面板：时间线 + 输入框 + 私聊，不含项目/群聊导航。 */
export function GroupPanel({
  projectId,
  groupId,
  agents,
  onError,
}: GroupPanelProps) {
  const [events, setEvents] = useState<WorkEvent[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [asTask, setAsTask] = useState(false);

  const displayName = (actorId: string): string =>
    agents.find((agent) => agent.id === actorId)?.name ?? actorId;

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      const result = await api.workEvents(groupId);
      if (!cancelled) setEvents(result.events);
    };
    void load().catch((error: Error) => onError(error.message));
    const timer = setInterval(() => {
      void load().catch(() => undefined);
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [groupId, onError]);

  const send = async (): Promise<void> => {
    if (!draft.trim()) return;
    setBusy(true);
    try {
      const intake = await api.sendWorkMessage(groupId, draft.trim(), []);
      setDraft('');
      if (asTask) {
        await api.triageWorkMessage(groupId, intake.event.id, {
          start: true,
        });
      } else if (intake.requiresAssistant) {
        await api.assistantTriage(groupId, intake.event.id);
      }
      const result = await api.workEvents(groupId);
      setEvents(result.events);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="group-panel">
      <div className="chat-body">
        {events.map((event) => {
          if (event.type === 'message.created') {
            const content = String(event.payload.content ?? '').trim();
            if (!content) return null;
            if (
              event.actorId === 'assistant' &&
              content.startsWith('已建工作项')
            ) {
              return null;
            }
            const outgoing = event.actorId === 'local-user';
            return (
              <div
                className={`chat-row ${outgoing ? 'chat-row--out' : ''}`}
                key={event.id}
              >
                <div className="chat-main">
                  {!outgoing ? (
                    <span className="chat-sender">
                      {displayName(event.actorId)}
                    </span>
                  ) : null}
                  <div className="chat-bubble">
                    <Markdown text={content} />
                  </div>
                </div>
              </div>
            );
          }

          if (event.type === 'assignment.reported') {
            const summary = String(event.payload.summary ?? '').trim();
            if (!summary) return null;
            return (
              <div className="chat-row" key={event.id}>
                <div className="chat-main">
                  <span className="chat-sender">
                    {displayName(String(event.payload.agentId ?? 'assistant'))}
                    {' · 执行报告'}
                  </span>
                  <div className="chat-bubble">
                    <Markdown text={summary} />
                  </div>
                </div>
              </div>
            );
          }

          if (
            event.type === 'assignment.started' ||
            event.type === 'assignment.progress'
          ) {
            return null;
          }

          const view = eventText(event);
          if (!view) return null;
          return (
            <div className="chat-system" key={event.id}>
              {view.label} · {view.text}
            </div>
          );
        })}
        {events.length === 0 ? (
          <div className="chat-system">还没有消息</div>
        ) : null}
      </div>

      <div className="group-composer-wrap">
        <label className="group-task-toggle">
          <input
            type="checkbox"
            checked={asTask}
            onChange={(event) => setAsTask(event.target.checked)}
          />
          作为任务执行
        </label>
        <div className="group-composer">
          <textarea
            rows={2}
            value={draft}
            placeholder="发消息… @Agent 可由它处理"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <button
            type="button"
            disabled={busy || !draft.trim()}
            onClick={() => void send()}
          >
            发送
          </button>
        </div>
      </div>
    </div>
  );
}

