# Spec Agent v2 架构设计

> 目标：以群聊为工作区，以事件驱动 Agent，以工作项承载执行，以记忆层解决跨会话上下文。
> 本文不兼容现有 `项目 → 会话` 模型；它是从零设计的目标架构。
>
> 左侧是「组织 Agent 好友列表 + 项目/群聊树」，点 Agent 在右侧内嵌私聊。
> 助理私聊通过本地 MCP `spec-agent-tools` 调用 `create_agent` / `list_agents`；MCP handler 只写 `agents.yaml` 并调用 `/api/agents/reload` 热加载，不开放项目文件工具。
> **当前实现范围：GitHub 事件可选；手动聊天/任务可用。** 工作区是一棵树：「项目 → 群聊」在同一侧栏，项目可以没有群聊。群聊采用微信式左右气泡/头像/系统消息，配色保持应用中性色。记忆、规则等能力自动运行，不再要求用户配置；遵循「少即是多」。
> 工作台只保留 `群聊` 与 `私聊`；GitHub 回执在后台自动发送，不要求用户管理队列。
> 打开项目直接进入群聊工作区，不再先经过会话列表。
> GitHub 事件直接创建 Work Item 并自动分派 assistant，跳过 LLM triage；流程更短、更确定。
> GitHub webhook 只需要 `projectId`；未指定群聊时自动使用/创建 `#GitHub`，减少配置。
> 界面不提供手动建群入口；GitHub 事件自动维护 `#GitHub`。
> 工作区只显示群聊侧栏与消息时间线；Work Items 面板与手动操作已隐藏。
> Work Items 面板、手动操作、评论/计划代码已删除，改用 `SimpleGroupWorkspace`。
> 旧群聊/记忆/出站/规则/评论 CSS 已清理。
> 旧任务/计划/执行/时间线 CSS 已清理，CSS 构建降至约 129 kB。
> GitHub 回执发送结果以 `outbox.pending` / `outbox.sent` / `outbox.failed` 事件回到群聊时间线。
> pending 超过 1 分钟会提示检查 `GITHUB_TOKEN`。
> `GET /api/github/status` 返回 transport / tokenConfigured / ready；工作区顶部展示回执状态。
> GitHub API 失败会保留状态码与响应正文，写入 outbox.failed。
> mock 403 验证：3 次重试后 failed，last_error 含 `403 {"message":"Bad credentials"}`。
> GitHub Webhook `ping` 直接返回 200，配置 webhook 时可正常验证。
> 配置 secret 时，ping 也必须带合法签名；签名校验在 pong 之前执行。
> signed ping 与 unsigned ping 拒绝均有集成测试覆盖。
> 推荐 webhook URL：`/api/github/webhook?projectId=...`（兼容 `/api/work/sources/github`）。
> 不传 `projectId` 时自动使用最近的项目，单项目部署可直接用 `/api/github/webhook`。
> 传递 `X-GitHub-Delivery` 时记录 delivery id；去重以 `externalId` 为主，delivery 重试与同一 issue 的重复推送都不会重复建项。
> GitHub 评论发送已用 mock GitHub API 验证：`POST /repos/{owner}/{repo}/issues/{n}/comments` + Bearer token。
> 群聊是只读事件流，不提供手动发消息/建项；人工交流走私聊。
> 时间线只显示 GitHub 事件与执行结果，隐藏历史 assistant 消息。
> App 入口直接渲染群聊工作区，不再加载旧会话列表/项目计划界面。
> 旧 `ConversationWorkspace` / `ChatRail` / `ProjectPlans` 组件已删除。

---

## 1. 核心判断

1. **群聊是工作区，不是聊天记录容器。**
2. **事件是唯一入口。** 用户消息、`@`、GitHub Issue、PR 评论、CI 失败、定时任务、Agent 完成报告，全部归一为事件。
3. **Agent 是执行器，不是会话。** Agent 不拥有长期上下文；上下文从记忆层按作用域装配。
4. **工作项是执行单元。** 一个需求/问题/变更对应一个 Work Item，Work Item 内部可以有 DAG 和多个 Assignment。
5. **项目计划不再是独立对象。** Work Item 的执行图就是计划，按需生成、按需修改。
6. **人只在必须做决定时出现。** 完成报告、阻塞、审批、需要业务决策时才通知。

---

## 2. 层级与入口

```text
Organization
├── Projects
│   ├── Group Chats
│   │   ├── Messages / Events
│   │   ├── Work Items
│   │   └── Assignments / Reports
│   ├── Project Memory
│   └── Repositories
└── Agents
    ├── Global Profile / Memory
    └── Private Chats
```

### 2.1 群聊

- 项目下可以有多个群聊，例如 `#产品`、`#前端`、`#事故响应`。
- 群聊是项目工作区；项目不再有“会话树”。
- 每个群聊有自己的成员、记忆、工作项视图和通知策略。
- 群聊消息不可变；编辑/删除作为新事件记录。

### 2.2 私聊

- 私聊是用户与某个 Agent 的长期入口，不属于某个项目群聊。
- 私聊可以查询该 Agent 的工作记录、任务、产物、阻塞。
- 私聊中要求改动时，Agent 不直接偷改项目；它向目标项目群聊发起 `change_request` 事件，由群聊的助理 Agent 接单。
- 私聊上下文不会被自动广播到群聊；需要显式“提到群里”。

### 2.3 Agent 团队

- Agent 属于组织，可以被分配到多个项目/群聊。
- Agent 有全局身份、能力、工具权限、模型与配置版本。
- 同一个 Agent 可以在多个群聊中被提及，但每次执行都是独立 Assignment 和独立上下文。

---

## 3. 领域模型

### Organization

```text
id, name, settings
agents[], source_connections[], policies[]
```

### Project

```text
id, org_id, name, repositories[]
groups[], memory_namespace, automation_policy
```

### GroupChat

```text
id, project_id, name, topic
members[]        // user | agent
policy           // who can ask, auto-accept, notification mode
memory_namespace
```

### Message

```text
id, group_id | private_chat_id
author: user | agent | system
content, mentions[], reply_to
created_at
```

消息只是事件的一种投影，不作为任务状态的事实来源。

### WorkItem

```text
id, project_id, group_id?
origin_event_id
requested_by: user | agent
title, intent, acceptance_criteria
state:
  inbox | triaged | ready | running |
  waiting_human | blocked | reviewing |
  done | failed | cancelled
priority
assignments[]
artifacts[]
created_at, updated_at
```

### Assignment

```text
id, work_item_id
agent_id
group_id
role: owner | reviewer | investigator | reporter
state: queued | running | waiting | done | blocked | failed
depends_on[]
requested_by_event_id
run_id?
```

### Run

```text
id, assignment_id
worktree, branch
dsh_session_id
started_at, finished_at
usage, status
```

### Report

```text
id, assignment_id
kind: progress | done | blocked | question | review
summary, artifacts[], next
created_at
```

### MemoryRecord

```text
id, scope_type, scope_id
kind: fact | decision | preference | summary | lesson
content, confidence
source_event_ids[]
created_at, updated_at, expires_at?
```

`scope_type`：`org | project | group | agent_global | private_thread | execution`

---

## 4. 统一事件模型

所有输入都是 `Event`：

```ts
type Event = {
  id: string;
  orgId: string;
  projectId?: string;
  groupId?: string;
  privateChatId?: string;

  source: 'chat' | 'github' | 'feishu' | 'ci' | 'schedule' | 'agent' | 'system';
  type:
    | 'message.created'
    | 'message.mention'
    | 'change.requested'
    | 'assignment.started'
    | 'assignment.reported'
    | 'workitem.created'
    | 'workitem.updated'
    | 'source.event'
    | 'policy.changed';

  actor: { type: 'user' | 'agent' | 'system'; id: string };
  payload: unknown;

  // 因果与幂等
  correlationId: string;
  causationId?: string;
  dedupeKey: string;
  depth: number;

  createdAt: string;
};
```

### 4.1 事件总线

- 持久化事件日志 + 事务 Outbox。
- 消费者至少一次投递；所有副作用带幂等键。
- 每个群聊、每个 Agent、每个 Work Item 都可以作为 actor，单写入者串行处理自己的事件流。
- 禁止业务代码直接“发消息”；只产生事件，由投递器决定写到哪个群聊/私聊/外部渠道。

### 4.2 `@` 就是事件

```text
消息 " @前端 修一下登录 "
  → message.created
  → mention parser 生成 recipients: [frontend]
  → message.mention 投递给 frontend Agent
```

`@` 不是特殊 UI 逻辑，而是标准事件路由字段。

---

## 5. 群聊路由规则

### 规则 1：没有 `@`

由该群聊的 **助理 Agent（Coordinator）** 处理：

- 回答问题
- 判断是否需要创建 Work Item
- 需要执行时创建 Work Item 和 Assignment
- 回复确认、计划或澄清问题

### 规则 2：`@某个 Agent`

由被 `@` 的 Agent 回复：

- 它可以直接完成问答
- 需要修改代码时，它创建/参与 Work Item
- 它不抢助理的协调职责，也不重复规划

### 规则 3：Agent 完成或阻塞

Assignment 记录 `requestedBy`：

- 完成后，执行 Agent 在群里 `@` 发起人，报告 `done`
- 阻塞/需要决策时，`@` 发起人，报告 `blocked` 或 `question`
- 报告是 `assignment.reported` 事件，不再触发新的执行循环

### 规则 4：私聊 Agent 提需求

```text
用户私聊 Agent: "把登录页改成邮箱登录"
Agent: 生成 change_request 事件
  → 目标项目群聊
  → 默认无 @，由助理 Agent 接收
  → 助理创建 WorkItem / Assignment
  → 完成后 @ 发起人
  → 同时把结果回投到发起私聊
```

### 规则 5：事件循环保护

- `correlationId` 贯穿全链路
- `depth` 限制接力深度
- `report_of` 标记完成报告，报告不再创建新 Work Item
- 同一个 Work Item 的重复事件按 `dedupeKey` 丢弃

---

## 6. Work Item 与执行

### 6.1 没有项目计划对象

项目计划删除。需要计划时：

```text
WorkItem
  ├── Assignment A (investigate)
  ├── Assignment B (implement, depends A)
  └── Assignment C (review, depends B)
```

DAG 属于 Work Item，不再是独立的项目级计划。

### 6.2 生命周期

```text
inbox
  → triaged
  → ready
  → running
  → waiting_human / blocked / reviewing
  → done / failed / cancelled
```

### 6.3 执行流程

1. 事件进入 Work Item。
2. Router 做意图识别、归属判断、优先级。
3. Assistant 创建 Assignment DAG。
4. Scheduler 选择 Agent 和并发槽。
5. Agent 获得独立 worktree、独立 DSH session、独立上下文。
6. Run 结束写 Report、Artifacts。
7. 完成/阻塞事件投递回群聊和发起人。
8. 合并/PR 由集成队列串行完成。

---

## 7. 多群聊并发

### 7.1 核心原则

**Agent 可以并行收到多个任务，但执行资源要分级串行。**

### 7.2 并发模型

| 资源 | 默认规则 |
|---|---|
| 同一 Agent 的交互回复 | 按群聊串行，避免多群聊串话 |
| 同一 Agent 的执行 Assignment | 默认最多 2 个并行，可配置 |
| 同一仓库写操作 | 全局串行（worktree 隔离 + 集成锁） |
| 同一 Work Item 内 | 按 DAG 依赖并行 |
| 只读分析 | 可并行 |
| 跨项目写 | 按仓库/项目锁串行 |

### 7.3 同一 Agent 多群聊

- 每个 Assignment 独立上下文，不共享可变 session。
- Agent 的全局记忆可读；群聊记忆只读当前群聊。
- 收到新任务时，先回复确认和位置：

```text
已接到。当前有 2 个执行中任务，本任务预计排队。
```

- 不静默阻塞用户。
- 交互问答优先于后台 Assignment。
- 任务取消使用 `cancelled`，不直接杀进程；Run 可中断，Work Item 保留。

### 7.4 物理隔离

- 每个写任务独立 git worktree。
- 写完成进入集成队列；集成串行。
- 只读任务可以共享缓存，但不能共享可写工作区。

---

## 8. 记忆架构

记忆按作用域分层，**不能把所有聊天记录塞进向量库**。

### 8.1 六层记忆

| 层 | 内容 | 生命周期 | 写入者 |
|---|---|---|---|
| Org | 组织规则、Agent 名册、通用约定 | 长期 | 管理员 / 审核后 |
| Project | 架构决策、领域术语、已知坑、仓库地图 | 长期 | Memory Writer + 人审 |
| Group | 群聊决策、未决问题、最近结论、成员偏好 | 中期 | 群聊摘要器 |
| Agent Global | Agent 的通用经验、风格、能力 | 长期 | Agent/管理员 |
| Private Thread | 用户与该 Agent 的私聊上下文 | 中期 | 私聊摘要器 |
| Execution | 当前 Assignment 的工具观察、计划、临时事实 | 临时 | Run 内写入 |

### 8.2 读取上下文

每个 Assignment 只装配：

```text
Org policy
+ Project memory
+ 当前 Group memory
+ Agent global memory
+ 当前 Private Thread memory（如果来自私聊）
+ 当前 Work Item / Assignment 状态
+ 相关 Artifacts
```

**绝不加入其他群聊的 memory。**

### 8.3 写入路径

```text
原始 Event / Message
  → 异步 Memory Writer
  → 候选事实（带 scope、sourceEventIds、confidence）
  → 去重 / 冲突检测
  → 写入对应层
```

- 原始消息不改写，记忆是派生视图。
- 每条记忆必须有来源事件。
- 项目决策必须人工确认或高置信度规则。
- 私聊内容进入群聊记忆必须显式“提升”。
- 群聊内容进入项目记忆需要摘要器 + 人审。
- Execution memory 在任务结束后压缩，原文按 TTL 清理。

### 8.4 “你做了什么”怎么回答

不能只靠语义记忆。查询结构化事实：

```text
WorkItem + Assignment + Run + Report + Artifacts
  → 时间线
  → 当前状态
  → 产物链接
  → 阻塞原因
```

模型只负责总结，不负责回忆事实。

### 8.5 记忆冲突

优先级：

```text
组织策略
> 项目决策
> 群聊结论
> Agent 偏好
> 临时执行记忆
```

同层冲突保留来源和时间，选择最新已确认版本；未确认的候选不覆盖旧事实。

---

## 9. 权限与配置

权限分三轴，不能混成一个“完全权限”：

### 9.1 文件沙箱

`read-only` / `workspace-write` / `danger-full-access`

### 9.2 工具权限

Agent 可用工具：`Read`、`Write`、`Edit`、`Glob`、`Grep`、`Shell`、`Git` 等。

### 9.3 Mandate（授权）

- 谁能向这个 Agent 提需求
- 哪些来源可以自动创建 Work Item
- 哪些动作自动接受
- 哪些动作必须人工确认
- 哪些群聊/项目/仓库可写

### 9.4 私聊助理的高权限

私聊助理可以：

- 生成 Agent 定义草案
- 生成节点草案
- 生成配置变更
- 展示 diff
- 用户确认后应用
- 自动备份 + 版本化 + 可回滚

但不能：

- 绕过校验直接覆盖 `agents.yaml`
- 静默创建高权限 Agent
- 修改未授权项目

配置变更必须走 Config Service，而不是 Agent 直接写 YAML。

---

## 10. 外部事件源

### GitHub

- Issue 创建/评论
- PR 评论、review
- CI 失败
- label 变化

### Feishu / IM

- 群消息
- 私聊
- 机器人被 @

### 其他

- 定时器
- Webhook
- 邮件
- 内部系统事件

### 两级过滤

```text
程序层：来源、作者、label、关键词、去重、权限、已处理
  ↓
语义层：Router LLM 判断归属、优先级、是否接单
```

程序层应该挡掉大部分事件，避免每条 GitHub 消息都调用模型。

---

## 11. 服务组件

```text
Event Gateway
  → Router / Triage
  → Conversation Service
  → WorkItem Service
  → Scheduler
  → Agent Runtime (DSH)
  → Tool Gateway
  → Memory Service
  → Outbox
  → Source Adapters
  → Config Service
  → Watchdog
```

### 存储建议

- Postgres：领域数据、事件日志、Work Item、记忆元数据
- pgvector：语义记忆检索
- Redis / NATS：队列、租约、短期锁（规模上来后）
- 对象存储：Artifacts、Worktree 快照
- 事务 Outbox：跨渠道可靠投递

### 一致性

- 每个群聊/Agent/Work Item 一个 actor，单写入者。
- 事件消费者幂等。
- 任务执行使用租约 + 心跳。
- Watchdog 检测卡住 Run、失联 Agent、未投递 Outbox。

---

## 12. 典型流程

### A. 群聊无 @

```text
用户: 登录页要支持邮箱
→ 助理接收
→ 创建 WorkItem
→ 分派前端 Agent
→ 前端完成
→ @用户 报告完成
```

### B. 群聊 @Agent

```text
用户: @前端 看下这个报错
→ 前端接收
→ 若只是分析，直接回复
→ 若需要改动，创建 WorkItem / Assignment
→ @用户 报告结果
```

### C. 私聊提改动

```text
用户私聊前端: 把按钮改成蓝色
→ 前端生成 change_request
→ 投递到项目群聊
→ 助理创建 WorkItem
→ 执行完成
→ 群里 @发起人 + 私聊回执
```

### D. GitHub Issue

```text
GitHub issue labeled agent
→ source adapter 生成 event
→ 去重/权限/关键词过滤
→ 助理 triage
→ 创建 WorkItem
→ 指派 Agent
→ 完成后回评论 / 开 PR
```

### E. 同一 Agent 多群聊

```text
群 A: @前端 修 A
群 B: @前端 修 B
→ 两个独立 Assignment
→ 独立 worktree
→ 并行执行（默认上限 2）
→ 写操作串行集成
→ 分别向群 A / 群 B 报告
```

---

## 13. 落地阶段

### Phase 1：领域与事件

- Organization / Project / GroupChat / WorkItem / Assignment / Report
- Event log + Outbox
- 群聊路由规则（无 @ 助理，@ 指定 Agent）

### Phase 2：执行与并发

- WorkItem DAG
- Assignment Scheduler
- 多群聊并发、worktree 隔离、集成锁
- 完成/阻塞报告回投

### Phase 3：记忆

- 六层 memory
- Memory Writer、去重、冲突
- 上下文装配器
- “你做了什么”时间线

### Phase 4：事件源

- GitHub / Feishu adapters
- 两级过滤
- 外部 Outbox 回执

### Phase 5：权限与自配置

- Mandate
- 私聊助理生成 Agent/节点草案
- Config Service + diff + 回滚
- Watchdog

---

## 14. 明确不做

- 不做传统 `项目 → 会话` 树
- 不做独立“项目计划”对象
- 不让 Agent 直接写 `agents.yaml`
- 不把群聊原文全部塞进向量库
- 不让多个群聊共享可变执行上下文
- 不让“完全权限”变成“绕过审批自动行动”
- 不在第一阶段做完整 Router/Worker 常驻集群

---

## 15. 关键决策摘要

| 问题 | 决策 |
|---|---|
| 工作区单位 | 群聊 |
| 私聊定位 | Agent 入口 + 工作查询 + 改动发起 |
| 无 @ | 助理接收并规划 |
| @ | 指定 Agent 回复/执行 |
| 完成后 | @ 发起人报告 |
| 执行单元 | WorkItem + Assignment |
| 计划 | WorkItem DAG，无独立计划对象 |
| 并发 | 交互按群聊串行；执行按 Agent 并行；写操作按仓库串行 |
| 记忆 | 六层作用域，严格隔离 |
| 外部事件 | 统一 Event，两级过滤 |
| 权限 | 沙箱、工具、Mandate 三轴 |
| 配置 | Config Service，版本化、可回滚 |

---

## 16. 实现进度

### 2026-11-18：领域底座

已完成：

- 迁移 v26：`work_groups`、`work_group_members`、`domain_events`、`work_items`、`work_assignments`、`work_reports`
- `WorkStore`：群聊、事件、Work Item、Assignment、Report 的持久化
- `WorkService`：
  - 群聊消息落事件
  - 无 `@` 路由给助理
  - `@Agent` 路由给指定 Agent
  - `dedupeKey` 幂等
  - Work Item 创建与 Assignment
  - Assignment 完成/阻塞报告，并 `@` 发起人
- `tests/unit/work-service.test.ts`：路由、完成报告、幂等
- `tests/integration/server-work.test.ts`：API 闭环

### HTTP API

- `GET/POST /api/work/groups`
- `GET /api/work/groups/:id/events`
- `POST /api/work/groups/:id/messages`
- `GET/POST /api/work/items`
- `GET /api/work/items/:id`
- `POST /api/work/assignments/:id/start`
- `POST /api/work/assignments/:id/report`

### 群聊 UI

- 工作台顶栏增加「群聊」入口
- 组织 → 项目 → 群聊页面
- 群列表 / 新建群聊
- 消息流
- Agent `@` 选择
- 不 @ 时显示「助理接单」
- 右侧 Work Items 列表
- 消息「建工作项」→ 助理 triage 成 Work Item 草案
- Work Item 详情：接受、分派、开始、完成
- 完成后群聊出现 `assignment.reported` 卡片并 @ 发起人

### Assignment 执行器

- `WorkExecutor` 把 Assignment 转成一次 `AgentRuntime.run`
- 使用当前项目的 DSH/AgentRuntime、provider、model、repo 工作区
- 后台异步执行；API 立即返回 `202 running`
- 完成写 `done` Report，失败写 `blocked` Report
- 群聊每 3 秒轮询执行状态
- 真实 DSH 已验证：Work Item「只回复执行器已接通」返回「执行器已接通」
- `assignment.started` / `assignment.progress` 事件：开始执行、工具调用、工具结果
- 群聊实时显示工具轨迹；真实 DSH 已验证 `read` 调用与结果

### 助理 LLM triage

- 无 @ 消息由助理调用 AgentRuntime 判断
- 决策：`create_work_item` / `reply` / `needs_info`
- 输出严格 JSON；解析失败退化为建工作项
- 创建后助理回复并 @ 发起人
- API：`POST /api/work/groups/:id/assistant-triage`
- 真实 DSH 已验证：需求 → 工作项 + 助理回复

### 私聊

- 迁移 v27：`private_threads` / `private_messages`
- 私聊可查该 Agent 在项目内的执行历史（`你做了什么？`）
- 支持选择目标群聊，把改动请求提到群聊
- 群聊事件由助理 LLM triage 接单并建 Work Item
- UI：群聊顶栏「私聊」抽屉，Agent 选择、消息流、提到群聊
- 真实 DSH 已验证：私聊需求 → #前端 → Work Item + 助理回复

### Context Assembler

- `ContextAssembler` 在每次 Assignment 执行前装配：
  - Work Item 标题/需求/状态
  - 当前群聊最近 20 条消息与报告
  - 私聊来源（若有 `privateThreadId`）
  - 项目记忆
  - Agent 记忆
  - 执行报告
- 默认字符预算 12k，超出按整段截断，不把其他群聊混进来
- `WorkExecutor` 把装配结果写入 Agent task 上下文
- 单测覆盖 Work Item / 群聊 / 项目记忆 / Agent 记忆

### 记忆写入

- 迁移 v28：`work_memories`，作用域 `org/project/group/agent/private/execution`
- `WorkMemoryWriter` 在执行完成/失败后写：
  - execution 记忆（按 assignment）
  - group 记忆（按 work item）
  - done 时写 project 记忆
- 同一 source 重新执行会更新，不重复插入
- Context Assembler 按作用域读取，并限制每层条数
- 真实验证：在 `#前端` 执行「记住项目代号 BLUE-42」，随后在新群聊 `#记忆验证` 询问「项目代号是什么」，DSH 回答 `BLUE-42`
- 验证写入：`project` / `group` / `execution` 三类记忆均落库

### 记忆检索

- 迁移 v29：`expires_at` / `last_used_at`
- `WorkMemoryStore.search`：
  - 中文 bigram + 英文词分词
  - BM25 近似词法评分
  - 叠加时间衰减、置信度、decision 权重
  - 过滤过期记忆，回写 `last_used_at`
- 同作用域相同内容自动合并，不重复插入
- Context Assembler 改为按 Work Item 标题/需求检索相关记忆；无命中才回退最近记忆
- 单测覆盖相关度、过期过滤、同内容合并

### 记忆治理

- 私聊来源的 Work Item 完成后写 `private` 记忆
- 记忆 API：
  - `GET /api/work/memories`（query 或 scope）
  - `POST /api/work/memories`
  - `DELETE /api/work/memories/:id`
- `supersedes`：新事实写入时让旧记忆过期，检索不再返回
- 支持显式 `expires_at`、`source`、`confidence`
- Org 记忆通过显式 API 写入，避免自动把任务日志塞进组织层
- 真实验证：旧项目记忆 `BLUE-42` 被 `GREEN-7` supersede；新群聊 `#冲突验证` 回答 `GREEN-7`

### Assignment 依赖

- 迁移 v30：`work_assignment_deps`
- Assignment 可声明 `dependsOn`
- `POST /execute` 检查依赖；未完成返回 `409 E_WORK_DEPENDENCY`
- UI 显示「等待 n 个依赖」，并禁用运行
- `WorkService.dependenciesSatisfied` 统一校验
- 集成测试覆盖：依赖未完成拒绝 → 前置完成 → 后置可运行
- `WorkExecutor.scheduleReady`：前置完成后自动启动所有依赖满足的 queued Assignment
- 多个 ready 节点并行启动；失败只记录，不阻塞其他节点
- UI 显示依赖链：`依赖：agent(done) → agent(running)`
- 分派时可选择前置 Assignment
- Work Item 详情增加了 SVG DAG：按依赖深度分列、连线、显示 Agent 和状态
- 群聊顶栏「记忆」抽屉：
  - 搜索记忆
  - 按作用域过滤
  - 新增组织/项目/群聊记忆
  - 删除记忆
- 搜索只返回词法命中；完全无命中时才回退最近记忆
- 记忆卡片支持「替换」：新内容写入同作用域并 `supersedes` 旧记忆
- 管理 UI 搜索关闭 fallback，无命中显示空状态

### DAG 控制

- Assignment 可取消：`POST /cancel`
- 运行中的 Run 通过 `AbortController` 中断；取消后不再写失败报告
- 可重试 `failed / cancelled / blocked`：`POST /retry` 重置为 queued
- UI：取消 / 重试按钮
- 全部 Assignment 取消/失败时 Work Item 标记 cancelled

### 私聊 LLM

- `PrivateAssistant` 基于 Agent 执行历史回答私聊问题
- 上下文：最近 Assignment、最新 Report、最近私聊
- 只读权限，不允许私聊直接改项目
- 失败时回退到结构化执行历史
- 真实 DSH 已验证：能总结已完成的 Work Item 和 queued 任务
- 私聊会检索 project / agent / private 记忆，并注入上下文
- 私聊流式：`POST /api/work/private/:agentId/stream`
  - SSE `status` / `delta` / `done`
  - 通过 ChatEngine `onDelta` 推送
  - 完成后落库最终文本

### 自动规划 DAG

- `WorkPlanner` 用 AgentRuntime 把 Work Item 拆成 1–5 个 Assignment
- LLM 只输出方案；应用层校验 Agent id、映射 dependsOn 下标
- 非法输出/调用失败回退为单 Assignment
- API：`POST /api/work/items/:id/plan`
- UI：Work Item 详情「自动拆解」

### 规划预览与确认

- `POST /api/work/items/:id/plan/preview`：只返回方案，不创建
- `POST /api/work/items/:id/plan/apply`：确认后创建 DAG
- UI 展示方案预览：第几步、Agent、依赖第几步
- 用户可取消；确认后才写入 Assignment
- 确认创建后立即启动依赖已满足的首批 Assignment；返回 `started[]`
- 方案预览可编辑：改 Agent、删除步骤、添加步骤；删除时重映射依赖下标
- 每步可直接选择「无依赖」或前面某一步作为前置
- 只有用户点「创建 DAG」才写库

### 外部事件源

- `POST /api/work/sources/github|feishu|ci`
- 统一落 `source.event`，再投递成 `message.created`
- `externalId` 做幂等：重复事件返回 `duplicate: true`，不重复建 Work Item
- 无 @ 消息由助理 LLM triage 接单
- 集成测试覆盖 GitHub issue → 助理回复；重复 issue 不重复处理

### 事件源签名

- `SPEC_AGENT_GITHUB_WEBHOOK_SECRET` / `SPEC_AGENT_FEISHU_WEBHOOK_SECRET` / `SPEC_AGENT_CI_WEBHOOK_SECRET`
- GitHub 读取 `X-Hub-Signature-256`
- 其他来源读取 `X-Spec-Agent-Signature`
- HMAC-SHA256，timing-safe 比较
- 未配置 secret 时保持开发模式放行

### 混合检索

- BM25 词法分 + 本地 hashed character n-gram 向量余弦
- 256 维、FNV-1a hashing，归一化后点积
- 向量分权重 1.4，叠加时间/置信度/decision 权重
- 零外部依赖；默认使用本地向量，可切换真实 embedding provider
- 低相似度且无词法命中的记忆不会进入结果

### Embedding Provider

- OpenAI 兼容 `POST {URL}/embeddings`
- 环境变量：`SPEC_AGENT_EMBEDDING_URL` / `_API_KEY` / `_MODEL`
- `WorkMemoryStore.searchAsync`：
  - 批量 embed 查询 + 候选记忆（上限 100）
  - 内存缓存 model + 文本向量
  - 余弦相似度 + 词法重叠组合
  - provider 失败自动回退本地检索
- 私聊 `answer` / `answerStream` 使用异步向量检索
- 记忆面板搜索 API `GET /api/work/memories?query=` 也使用 `searchAsync`
- ContextAssembler `assembleAsync` 使用异步向量检索，WorkExecutor 已切换
- 未配置 provider 时回退同步本地检索
- 迁移 v38：`work_memory_vectors` 按 `model + sha256(text)` 持久化向量
  - 查询与文档向量都缓存
  - 重启后同一文本不再请求 provider
- 向量运维：
  - `GET /api/work/memory-vectors/stats`：model、调用/失败、向量数
  - `POST /api/work/memory-vectors/cleanup`：按天数清理；`-1` 清空
  - 记忆面板显示向量统计并提供「清理向量」
- 迁移 v40：`work_embedding_metrics` 持久化调用/失败/最近错误
  - 重启后 stats 保留
  - 按 model 分开
- 迁移 v41：`work_embedding_project_metrics` 按项目分桶
  - stats 支持 `?projectId=`，返回 `project.calls/failures`
  - 记忆面板显示本项目调用次数
- `MemoryJanitor`：
  - 服务启动时清理一次，之后每小时
  - 删除过期记忆 + 超过 `SPEC_AGENT_VECTOR_CLEANUP_DAYS` 的向量
  - `SPEC_AGENT_MEMORY_JANITOR_MS` 可调间隔
  - 同时清理记忆版本：`SPEC_AGENT_MEMORY_VERSION_DAYS` / `_VERSIONS_KEEP`
  - 清理 Outbox 审计：`SPEC_AGENT_OUTBOX_AUDIT_DAYS`（默认 180 天）
  - 服务关闭时停止

### 记忆作用域校验

- 写入时校验作用域归属
- org：scopeId 必须是 `org`
- project：scopeId 必须等于 projectId
- group：必须存在且属于 projectId
- agent：scopeId 作为 agentId 写入
- UI 创建入口只提供 org / project / 当前群聊
- 额外提供 Agent 作用域：选择目标 Agent 后写入 `agent` 记忆
- 额外提供 Agent 私聊作用域：解析私聊线程后写入 `private` 记忆
- 记忆支持原地编辑：`PATCH /api/work/memories/:id`
- 「替换」仍创建新记忆并 supersedes 旧记忆
- 迁移 v39：`work_memory_versions` 保存编辑前内容
- `GET /api/work/memories/:id/versions` 查看历史；UI「历史」
- `POST /api/work/memories/:id/versions/:versionId/restore` 恢复历史版本
- PATCH 支持 `expectedUpdatedAt`；不一致返回 `409 E_WORK_MEMORY_CONFLICT`
- 恢复前会把当前内容再存为版本
- `GET /api/work/memories/:id/versions/:versionId/diff` 返回行级 diff
- UI 历史版本支持「对比」展示 +/- 行
- `POST /api/work/memory-versions/cleanup`：每条记忆保留最近 N 个版本
- 记忆面板「清理版本」

### 记忆冲突

- `findConflicts`：同作用域内 `向量余弦 * 0.7 + 词法 Jaccard * 0.3`
- 默认阈值 0.35，排除相同内容与过期记忆
- API：`POST /api/work/memories/conflicts`
- UI 新增记忆时提示相似旧事实：
  - 取消
  - 仍然新增
  - 替换并记住（supersedes）
- `autoResolveConflicts: true`：写入前自动让相似旧事实过期
- `WorkMemoryWriter` 的 group/project 记忆默认启用自动裁决

### 记忆 TTL

- `ttlDays` 写入相对过期时间
- 默认 TTL：
  - execution 30 天
  - group 90 天
  - private 180 天
  - project 长期
- `list` 默认隐藏过期记忆，`includeExpired` 可查
- `POST /api/work/memories/cleanup` 物理删除过期记忆
- 记忆面板增加「清理过期」

### Agent 并发

- 单 Agent 同时运行的 Assignment 上限：默认 2
- 环境变量：`SPEC_AGENT_MAX_AGENT_CONCURRENCY`
- 手动 execute 超出上限 → 400「并发已满」
- 自动调度跳过满负载 Agent；某个任务完成后自动接续 queued 任务
- 完成事件后扫描**整个项目**的 queued Assignment，不只当前 Work Item
- 因此同一 Agent 在不同 Work Item / 群聊间也能按并发上限接续

### Outbox

- 迁移 v32：`work_outbox`
- 来源事件 Work Item 完成时，自动生成 `comment` 回执
- 回执含 source、externalId、workItemId、reportId、正文
- API：
  - `GET /api/work/outbox?projectId=&status=`
  - `POST /api/work/outbox/:id/status`
- 当前只落可靠队列，尚未真正调用 GitHub/飞书 API

### Outbox Worker

- 迁移 v33：attempts / max_attempts / last_error / next_attempt_at
- 唯一约束：project + source + externalId + workItem + kind，避免重复回执
- `OutboxWorker` 轮询 pending：
  - 成功 → sent
  - 失败 → attempts+1，指数退避，达到上限 → failed
- transport：
  - `SPEC_AGENT_OUTBOX_TRANSPORT=log`
  - 或 `SPEC_AGENT_OUTBOX_URL` + `SPEC_AGENT_OUTBOX_TOKEN`
  - 或 `SPEC_AGENT_OUTBOX_TRANSPORT=github` + `GITHUB_TOKEN`
- GitHub transport 从回执 `payload.url` 解析 owner/repo/number，调用 issue comments API
- `POST /api/work/outbox/run` 手动触发一次
- `POST /api/work/outbox/:id/retry` 重置失败回执
- `POST /api/work/outbox/:id/send` 只发送指定回执
- 迁移 v42：`work_outbox_attempts` 审计每次发送
- `GET /api/work/outbox/:id/attempts`；UI「记录」展开
- `GET /api/work/outbox/audit.csv?projectId=` 导出项目审计 CSV
- 出站抽屉「导出审计」
- 出站支持待发送多选与「发送选中」批量发送
- 出站「重试失败」一次重置全部 failed 回执
- 群聊顶栏「出站」抽屉：状态筛选、运行队列、标记已发送、失败重试
- GitHub 原生 webhook：支持 `issues` / `issue_comment` / `pull_request` payload
- `projectId` / `groupId` 可用 query 参数映射，适配真实 webhook URL
- `externalId` 由 repo + number + updated_at（或 comment id）生成
- Action 白名单：`SPEC_AGENT_GITHUB_ACTIONS`，默认 `opened,reopened,created,ready_for_review,submitted`
- 支持 `pull_request_review_comment` 与 `pull_request_review` 归一化
- Review comment URL 含 `#discussion_r<id>` 时，Outbox 回复到 `/pulls/{n}/comments` 并带 `in_reply_to`
- Outbox 回执 payload 保留来源 URL，GitHub transport 依赖它定位 issue/PR/thread
- 被过滤事件返回 `202 {ignored:true}`，不创建 Work Item
- 迁移 v34：`work_source_rules`，按 project/group/source 配置 actions/enabled
- 迁移 v35：规则支持 `labels` / `authors` 白名单
- API：`GET/POST /api/work/source-rules`、`DELETE /:id`
- 群聊规则优先于全局 `SPEC_AGENT_GITHUB_ACTIONS`
- 过滤顺序：enabled → actions → labels → authors

### Work Item 评论

- 迁移 v36：`work_item_comments`
- `GET/POST /api/work/items/:id/comments`
- 评论写入 `workitem.commented` 事件
- Work Item 详情展示评论并可直接发表
- 评论可带 `agentId`：同时创建 Assignment，并立即进入 ready 调度- ContextAssembler 注入最近 10 条 Work Item 评论，Agent 能读到评论指令
- UI「同时交给助理执行」
- 评论派单可选择任意 Agent（Agent 选择器），不再固定 assistant
- 正文 `@Agent`（如 `@fe`）可直接触发派单，无需勾选
- 评论支持编辑/删除：`PATCH/DELETE /api/work/items/:id/comments/:commentId`
- 编辑/删除分别写 `workitem.comment_updated` / `workitem.comment_deleted` 事件
- Work Item 优先级：`PATCH /api/work/items/:id`，调度按 priority 降序
- 详情页优先级选择：普通/较高/高/紧急
- 群聊顶栏「规则」抽屉：
  - 规则列表（source / 作用域 / actions / enabled）
  - 新建/编辑：来源、项目或群聊、actions、启停
  - 删除规则

### 启动恢复

- 服务启动时扫描所有 `running` Assignment
- 退回 `queued`，Work Item 恢复 `ready`
- 对恢复的 Work Item 重新调用 ready 调度，自动接续执行
- 内存并发计数在重启后清零，由恢复流程重新建立

### 死信

- 迁移 v31：`attempts` / `max_attempts`（默认 3）
- 每次执行自增 attempts
- 达到上限后：
  - 再执行返回「死信」错误
  - 重试被拒绝
  - `GET /api/work/dead-letters?projectId=` 可查
- UI 显示 `2/3`，死信显示禁用「死信」按钮
- 死信可重置：`POST /assignments/:id/requeue`
  - attempts 归零
  - 可同时提高 `maxAttempts`
  - 回到 queued，Work Item 恢复 ready

下一步：

1. 接入真实 embedding provider
2. 私聊流式输出
3. TTL 配置化
4. 自动裁决阈值按 scope 配置

