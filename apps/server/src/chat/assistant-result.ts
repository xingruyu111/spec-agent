import type { AgentConfig } from '@spec-agent/schema';
import type { MemoryProvider } from '@spec-agent/core';
import type { ChatEngineRunResult } from '../dsh/dsh-chat.js';
import type { ChatRepository } from './chat-store.js';
import type { ChatMode, ChangeSetRow, ProjectPlanDraftRow } from './store-types.js';
import { firstTitle, parseChangeBlock, parseProjectPlanBlock } from './parsers.js';
import { validateProjectPlanDraft } from '@spec-agent/runtime';

type AssistantResultDeps = {
  repo: ChatRepository;
  agents: () => AgentConfig[];
  maxWorkstreams?: number;
  memory?: MemoryProvider;
  projectId?: string;
};

export async function recordAssistantResult(
  deps: AssistantResultDeps,
  sessionId: string,
  userText: string,
  mode: ChatMode,
  result: ChatEngineRunResult,
  options: { updateTitle: boolean },
): Promise<void> {
    const parsed = parseChangeBlock(result.text);
    const parsedPlan = parseProjectPlanBlock(parsed.text);
    const visibleText = parsedPlan?.text ?? parsed.text;
    const reasoning = result.reasoning?.trim().slice(0, 16_000);
    let changeSet: ChangeSetRow | undefined;
    let projectPlanDraft: ProjectPlanDraftRow | undefined;
    if (parsed.change) {
      changeSet = deps.repo.createChangeSet({
        sessionId,
        summary: parsed.change.summary,
        operations: parsed.change.operations,
      });
    }
    if (parsedPlan) {
      const agents = deps.agents();
      const defaultAgent =
        agents.find((agent) => agent.parent === null)?.id ?? agents[0]?.id ?? '';
      const workstreams = validateProjectPlanDraft(
        parsedPlan.value,
        agents,
        defaultAgent,
        deps.maxWorkstreams ?? 16,
      );
      projectPlanDraft = deps.repo.createProjectPlanDraft({
        sessionId,
        title:
          typeof parsedPlan.value.title === 'string'
            ? parsedPlan.value.title
            : userText.slice(0, 80),
        goal: userText,
        verifyCommand:
          typeof parsedPlan.value.verifyCommand === 'string'
            ? parsedPlan.value.verifyCommand
            : null,
        workstreams,
      });
    }
    deps.repo.addMessage({
      sessionId,
      role: 'assistant',
      content:
        visibleText ||
        (changeSet
          ? '已生成配置变更草案。'
          : projectPlanDraft
            ? '已生成项目计划草案。'
            : 'DSH 没有返回可展示的文本，请重试。'),
      mode,
      ...(reasoning ? { reasoning } : {}),
      ...(changeSet ? { changeSetId: changeSet.id } : {}),
      ...(projectPlanDraft ? { projectPlanDraftId: projectPlanDraft.id } : {}),
      ...(!changeSet && !projectPlanDraft && !visibleText
        ? { status: 'error' as const }
        : {}),
    });
    deps.repo.updateSession(sessionId, {
      dshSessionId: result.sessionId,
      ...(options.updateTitle ? { title: firstTitle(userText) } : {}),
    });
    if (deps.memory && visibleText.trim()) {
      void deps.memory.ingestConversation({
        projectId: deps.projectId ?? 'local',
        sessionId,
        agentId: 'project-copilot',
        messages: [
          { role: 'user', content: userText },
          { role: 'assistant', content: visibleText },
        ],
      }).catch((error) => {
        console.warn(
          'memory conversation ingest failed:',
          error instanceof Error ? error.message : error,
        );
      });
    }
  }


