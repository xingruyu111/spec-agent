import type { AgentConfig } from '@spec-agent/schema';
import type { MemoryProvider, Store } from '@spec-agent/core';
import type { ChatRepository } from './chat-store.js';
import { composeGroupCustomPrompt } from '../assistant/prompt-composer.js';

type QaPromptDeps = {
  root: string;
  projectName?: string;
  projectId?: string;
  memory?: MemoryProvider;
  store: Store;
  repo: ChatRepository;
  agents: () => AgentConfig[];
};

const SPEC_AGENT_CAPABILITY_MAP = [
  '- 项目：支持多项目、创建/归档项目、项目计划（workstream/milestone/依赖）和 draft → 确认后启动。',
  '- 任务：任务模式会规划并创建任务；支持 DAG、审批、取消、失败重试、恢复、子任务和并行执行。',
  '- 节点：llm、shell、verify、delegate、subworkflow、condition、loop、fanout；计划批准前可编辑。',
  '- 交付：required outputPath、doneCriteria judge、artifact schema；支持文本/文件/JSON/diff/图片/音频/视频/二进制预览与审批。',
  '- 仓库：现有 Git 仓库、monorepo writeScope、多仓库 repoPath；提交、diff、blame 和合并记录可在任务详情查看。',
  '- 上下文：项目 skills、显式 MCP servers、项目知识索引、长期记忆；问答只读，不能直接写项目文件。',
  '- 资源：项目/日预算、节点/子任务/root task 并发、Claude transcript 续跑、provider/模型能力路由。',
  '- 界面：任务总览只显示当前状态与工作流；执行、计划、提交/产物、诊断在二级详情查看。',
  '- 对话边界：可以回答问题、生成 hive-change 或 hive-project-plan 草案；不要声称已经点击界面、批准、启动或修改配置。执行任务时提示用户切换到任务模式。',
].join('\n');

function groupCustomPrompt(agents: AgentConfig[]): string {
  const copilot =
    agents.find((agent) => String(agent.id) === 'assistant') ??
    agents.find((agent) => agent.parent === null) ??
    agents[0];
  return copilot?.systemPrompt?.trim() ?? '';
}

export async function buildQaPrompt(
  deps: QaPromptDeps,
  sessionId: string,
  content: string,
): Promise<string> {
    const agents = deps.agents();
    const agentLines = agents.map((agent) => {
      const nodes = (agent.nodes ?? [])
        .map((node) => `    - ${node.id}: ${node.name} — ${node.description}`)
        .join('\n');
      return `- ${agent.id} | ${agent.name} | parent=${agent.parent ?? 'root'} | role=${agent.role}${
        nodes ? `\n${nodes}` : ''
      }`;
    });
    const recent = deps.repo
      .listMessages(sessionId, 16)
      .slice(0, -1)
      .slice(-8)
      .map((message) => `${message.role === 'user' ? '用户' : '助手'}：${message.content}`)
      .join('\n');
    const memories = deps.memory
      ? (await deps.memory.retrieve({
          projectId: deps.projectId ?? 'local',
          agentId: 'project-copilot',
          query: content,
          limit: 6,
        })).memories
      : deps.store.memoryDigest(null, content, 6);
    const rootTasks = deps.store
      .listTasks(200)
      .filter((task) => task.parentId === null);
    const activeTaskCount = rootTasks.filter((task) =>
      !['succeeded', 'failed', 'cancelled'].includes(task.status),
    ).length;
    const pendingGateCount = deps.store.listPendingGates().length;
    const recentTaskLines = rootTasks.slice(0, 5).map((task) =>
      `- [${task.status}] ${task.title.slice(0, 100)} · ${task.assignee}`,
    );
    const planLines = deps.store.listProjectPlans(4).map((plan) =>
      `- [${plan.status}] ${plan.title}`,
    );
    const permission =
      deps.repo.getSession(sessionId)?.permissionMode ?? 'read-only';
    const permissionLine =
      permission === 'read-only'
        ? '你只能读取当前项目，不能直接写文件。'
        : permission === 'workspace-write'
          ? '你可以在当前项目工作区内读取和修改文件；不要写入工作区外。'
          : '你有完全文件权限，但仍不要执行未经用户确认的破坏性操作。';

    return [
      `你是 Spec Agent 的项目 Copilot。${permissionLine}`,
      `项目根目录：${deps.root}`,
      `项目名称：${deps.projectName ?? '未命名项目'}`,
      '',
      'Spec Agent 功能地图（这些是产品事实，回答功能问题时以此为准）：',
      SPEC_AGENT_CAPABILITY_MAP,
      '',
      '当前项目动态摘要：',
      `- root 任务 ${rootTasks.length} 个，进行中/等待 ${activeTaskCount} 个，待审批 ${pendingGateCount} 项`,
      '- 最近任务：',
      recentTaskLines.length > 0 ? recentTaskLines.join('\n') : '  （暂无任务）',
      '- 项目计划：',
      planLines.length > 0 ? planLines.join('\n') : '  （暂无项目计划）',
      '',
      '当前组织：',
      agentLines.length > 0 ? agentLines.join('\n') : '(尚未配置 agent)',
      '',
      '当前项目记忆：',
      memories.length > 0 ? memories.map((memory) => `- ${memory}`).join('\n') : '(无)',
      '',
      '最近对话：',
      recent || '(无)',
      '',
      '回答要求：',
      '1. 用中文，直接回答问题；需要时解释工作流影响。',
      '2. 不要声称你已经修改了配置；你只能提出变更草案。',
      '3. 当用户要求新增/修改/删除 agent 或节点时，在回答末尾附加一个 hive-change 代码块：',
      '   parent 必须是已有 agent 的 id，或 null 表示根 agent；不要写 "root"。',
      '   每个 upsert_node 都必须同时给出 outputPath 和 doneCriteria；不要只写 description。',
      '   outputPath 用项目内相对路径，doneCriteria 必须是可验证的条件。',
      '```hive-change',
      '{"summary":"一句话说明","operations":[{"op":"upsert_agent","agent":{"id":"fe","name":"前端","parent":"pm","role":"前端实现","model":{"provider":"inherit","model":"inherit"},"skills":[],"tools":{"allow":["Read","Write","Edit"],"shell":"readonly"},"workspace":{"writeScope":["."]},"nodes":[]}}]}',
      '```',
      '   节点示例：{"op":"upsert_node","agentId":"fe","node":{"id":"login-ui","name":"登录页实现","description":"实现登录页","instructions":"按设计稿实现页面","outputPath":"web/login.html","doneCriteria":"页面可打开，邮箱密码校验有对应测试或手工验证步骤"}}。',
      '4. 其他操作支持：upsert_node {agentId,node}、delete_node {agentId,nodeId}、delete_agent {id}。',
      '5. 变更草案会被用户确认后才应用；不要在正文里重复 JSON。',
      '6. 当用户要求创建或调整整个项目的阶段计划时，在回答末尾附加一个 hive-project-plan 代码块。按交付物拆 workstream，不按行业套模板；assignee 必须使用当前组织已有 agent id，dependsOn 使用 workstream id，依赖必须真实且无环。',
      '```hive-project-plan',
      '{"title":"项目计划标题","verifyCommand":"pnpm test","workstreams":[{"id":"ws-1","title":"阶段交付","brief":"目标、边界与交付物","assignee":"pm","milestone":"M1 阶段名","repoPath":"","dependsOn":[]}]}',
      '```',
      '   verifyCommand 可为空字符串；计划草案只会保存为 draft，不会直接启动。需要新增 agent 才能规划时，先给 hive-change，等用户应用后再生成项目计划，不要引用尚不存在的 assignee。只有用户明确给出独立仓库绝对路径时才设置 workstream.repoPath。',
      '',
      composeGroupCustomPrompt(groupCustomPrompt(deps.agents())),
      '',
      `用户：${content}`,
    ].join('\n');
  }

