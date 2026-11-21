import { useCallback, useEffect, useState } from 'react';
import { Button, IconButton, Select, Textarea } from '@spec-agent/ui';
import {
  api,
  type Agent,
  type PrivateMessage,
  type WorkGroup,
} from '../api.js';
import { Markdown } from './Markdown';

type PrivateChatProps = {
  projectId: string;
  agents: Agent[];
  groups: WorkGroup[];
  onClose: () => void;
  onError: (message: string) => void;
  embedded?: boolean;
  initialAgentId?: string;
};

export function PrivateChat({
  projectId,
  agents,
  groups,
  onClose,
  onError,
  embedded = false,
  initialAgentId,
}: PrivateChatProps) {
  const [agentId, setAgentId] = useState(
    initialAgentId ?? agents[0]?.id ?? 'assistant',
  );
  const [messages, setMessages] = useState<PrivateMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [targetGroupId, setTargetGroupId] = useState('');
  const [streamingText, setStreamingText] = useState('');
  const [reasoningText, setReasoningText] = useState('');
  const [streamStatus, setStreamStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const activeAgent = agents.find((agent) => agent.id === agentId);

  const load = useCallback(async () => {
    const result = await api.privateMessages(projectId, agentId);
    setMessages(result.messages);
  }, [agentId, projectId]);

  useEffect(() => {
    void load().catch((error: Error) => onError(error.message));
  }, [load, onError]);

  const send = async (toGroup: boolean): Promise<void> => {
    const content = draft.trim();
    if (!content) return;
    if (toGroup && !targetGroupId) {
      onError('先选择一个目标群聊');
      return;
    }
    const optimistic: PrivateMessage = {
      id: `pending-${Date.now()}`,
      threadId: 'pending',
      actorType: 'user',
      actorId: 'local-user',
      content,
      metadata: {},
      createdAt: new Date().toISOString(),
    };
    setMessages((current) => [...current, optimistic]);
    setDraft('');
    setBusy(true);
    try {
      if (!toGroup) {
        setStreamingText('');
        setStreamStatus('thinking');
        const result = await api.streamPrivateMessage(
          {
            projectId,
            agentId,
            content,
          },
          {
            onDelta: (text) =>
              setStreamingText((current) => current + text),
            onReasoning: (text) =>
              setReasoningText((current) => current + text),
            onStatus: (status) => setStreamStatus(status),
          },
        );
        setMessages(result.messages);
        return;
      }
      const result = await api.sendPrivateMessage({
        projectId,
        agentId,
        content,
        targetGroupId,
      });
      setMessages(result.messages);
    } catch (error) {
      setMessages((current) =>
        current.filter((message) => message.id !== optimistic.id),
      );
      setDraft(content);
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      setStreamingText('');
      setReasoningText('');
      setStreamStatus('');
    }
  };

  return (
    <aside
      className={`private-chat ${
        embedded ? 'private-chat--embedded' : ''
      }`}
    >
      {!embedded ? (
        <header className="private-chat-head">
          <div>
            <b>{activeAgent?.name ?? agentId}</b>
          </div>
          <IconButton label="关闭私聊" size="sm" onClick={onClose}>
            ×
          </IconButton>
        </header>
      ) : null}

      {!embedded ? (
        <div className="private-agent-row">
          <Select
            aria-label="选择 Agent"
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
          >
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </Select>
        </div>
      ) : null}

      <div className="private-messages">
        {messages.length === 0 ? (
          <div className="private-empty">
            <b>问它做了什么</b>
            <p>私聊可以查执行记录；要改东西时，把它提到群聊。</p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setDraft('你最近做了什么？')}
            >
              你最近做了什么？
            </Button>
          </div>
        ) : null}
        {messages.map((message) => {
          const reasoning =
            typeof message.metadata.reasoning === 'string'
              ? message.metadata.reasoning
              : '';
          return (
            <div
              className={`private-message ${message.actorType}`}
              key={message.id}
            >
              {reasoning ? (
                <details className="private-reasoning">
                  <summary>思考过程</summary>
                  <div>{reasoning}</div>
                </details>
              ) : null}
              <Markdown text={message.content} />
            </div>
          );
        })}
        {streamingText || (busy && streamStatus) ? (
          <div className="private-message agent">
            {reasoningText ? (
              <details className="private-reasoning" open>
                <summary>思考过程</summary>
                <div>{reasoningText}</div>
              </details>
            ) : null}
            <Markdown text={streamingText || '思考中…'} />
          </div>
        ) : null}
      </div>

      <div className="private-composer">
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send(false);
            }
          }}
          placeholder="问它做了什么，或写下一个改动需求…"
          rows={2}
          disabled={busy}
        />
        {!embedded ? (
          <Select
            aria-label="目标群聊"
            value={targetGroupId}
            onChange={(event) => setTargetGroupId(event.target.value)}
          >
            <option value="">提到群聊…</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </Select>
        ) : null}
        <div className="private-composer-foot">
          {!embedded ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || !targetGroupId || !draft.trim()}
              onClick={() => void send(true)}
            >
              提到群聊
            </Button>
          ) : null}
          <Button
            variant="primary"
            size="sm"
            loading={busy}
            disabled={busy || !draft.trim()}
            onClick={() => void send(false)}
          >
            发送
          </Button>
        </div>
      </div>
    </aside>
  );
}

