# Changelog

## Unreleased — 2026-11-13

### UI 组件库

- 新增本地 `@spec-agent/ui`，按 DSH 视觉基线维护 token 与 primitives
- 对照官方 `packages/client/ui-primitives`（MIT）对齐：Button 36/28、Input 32/14px、SegmentedControl ARIA tablist + 滑动 indicator
- 组件：Button / IconButton / Input / Textarea / Select / Field / Dialog / SegmentedControl / Surface / Badge / Spinner / EmptyState / SectionHeader
- Select 改为 DSH 风格自定义下拉：Portal 弹层、optgroup 分组、选中勾、键盘上下/Enter/Escape
- 不引入 Tailwind、shadcn、Ant Design 或第三方组件库
- 首页登录、供应商入口、hero、composer、空状态已迁移
- ChatRail 模式切换、composer、发送、模型选择已迁移
- ConversationWorkspace 项目选择、子项目操作、会话/组织小按钮已迁移
- AgentEditor 与 ProviderManager 外框迁移到 `Dialog`，内部输入/选择/文本域迁移到 `Input`/`Select`/`Textarea`
- TaskPreview 使用 `Badge` 状态、`SectionHeader` 分区、`Button` 审批/关闭/打开完整任务
- ProjectPlans 与新建项目弹窗迁移到 `Dialog`，计划创建使用 `Textarea`/`Input`/`Button`
- 新增 `Tooltip`（hover/focus、四个方向）与 `Menu`（键盘 Esc/外点关闭、危险项）
- 首页项目卡 Surface 化、卡片改为 420px 竖版居中布局，打开态使用 `Tag`
- 清理旧 `create-project-actions` / `plans-modal` / `agent-editor-actions` / `project-archive` / `right-tabs` / `provider-actions` 样式
- 右侧上下文分区迁移到 `SectionHeader` / `Badge` / `Button`；最近任务状态中文化
- TaskPreview 计划编辑的节点/依赖/指令表单迁移到 `Select`/`Input`/`Textarea`/`Button`
- 首页项目卡操作改为 `Menu`，Tooltip 接入 ChatRail 图标按钮
- 新增官方同名 `Tag`，`Dialog` 增加 `Modal` 别名

### DSH 运行时统一

- 新增 `DshAgentRuntime`：组织 Agent、规划器、任务节点统一走 DSH SDK
- 支持 Anthropic Messages 与 OpenAI Compatible provider，DeepSeek 等 OpenAI 供应商可用于任务
- 节点工具事件映射为 `tool/call` / `tool/result`，产物、usage、stop reason 继续写回 Hive
- 组织 Agent、规划器、任务节点统一走 DSH SDK，Claude Agent SDK 不再参与默认运行链路
- 供应商弹窗去掉默认供应商/模型，保存时自动取第一个带模型的供应商
- 聊天支持会话级权限：仅可查看 / 工作区内修改 / 完全权限；持久化到 `chat_sessions.permission_mode`
- 聊天输入框右下角增加权限菜单；DSH Chat 与 AgentRuntime 按会话权限运行

### v2 领域底座

- 新增 migration v26：群聊、事件、Work Item、Assignment、Report
- 新增 `WorkStore` / `WorkService`：群聊消息事件化、无 @ 路由助理、@ 路由指定 Agent
- `/api/work/*`：群聊、事件、Work Item、Assignment start/report
- 新增群聊 UI：工作台「群聊」入口、群列表、消息流、@ 选择、Work Items 侧栏
- 群聊消息「建工作项」：助理 triage → Work Item；支持接受、分派、开始、完成
- `WorkExecutor`：Assignment 异步调用 DSH/AgentRuntime，完成/失败自动写回 Report
- 群聊每 3 秒轮询执行状态；真实 DSH 已跑通 Work Item 执行
- `assignment.started` / `assignment.progress`：开始执行、工具调用/结果回写群聊
- 群聊展示实时工具轨迹；真实 DSH `read` 调用已验证
- 助理 LLM triage：无 @ 消息自动判断建工作项 / 回复 / 追问，并 @ 发起人
- 真实 DSH 已验证：需求 → 工作项 + 助理回复
- 私聊：migration v27、执行历史查询、私聊需求提到群聊
- 群聊「私聊」抽屉；真实 DSH 已验证私聊 → 群聊 → Work Item
- `ContextAssembler`：执行前装配 Work Item、群聊近况、私聊来源、项目/Agent 记忆和执行报告
- 迁移 v28 + `WorkMemoryWriter`：执行完成写 execution/group/project 记忆，重跑按 source 更新
- Context Assembler 按作用域读取 v2 记忆
- 真实 DSH 验证跨群聊记忆：`#前端` 记住 `BLUE-42`，`#记忆验证` 正确回答
- 迁移 v29 + 记忆检索：中文 bigram/BM25 词法评分、时间/置信度排序、过期过滤
- Context Assembler 按 Work Item 查询相关记忆；同内容记忆自动合并
- 私聊来源任务写 private 记忆；记忆 API 支持查询/写入/删除
- `supersedes` 冲突覆盖：旧记忆过期，检索只返回新事实
- 真实验证：`BLUE-42` 被 `GREEN-7` 覆盖，新群聊回答 `GREEN-7`
- 迁移 v30：Assignment 依赖；未满足依赖时拒绝执行，UI 显示等待状态
- 前置完成后自动调度满足依赖的后置 Assignment；UI 显示依赖链
- 分派 UI 可选择前置 Assignment；详情增加 SVG DAG 依赖图
- 群聊「记忆」抽屉：搜索、作用域过滤、新增、删除；搜索只返回词法命中
- 记忆卡片支持「替换」：`supersedes` 旧记忆；管理 UI 无命中返回空状态
- Assignment 取消/重试：运行中 abort，取消不写失败报告；UI 增加取消/重试
- 私聊 LLM：基于执行历史回答「你做了什么」，只读权限，失败回退结构化历史
- `WorkPlanner` + 「自动拆解」：助理把 Work Item 拆成带依赖的 Assignment DAG
- 自动拆解改为先预览、确认后创建；新增 plan/preview 与 plan/apply
- 确认创建 DAG 后自动启动依赖满足的首批 Assignment
- 规划预览可编辑：修改 Agent、增删步骤并重映射依赖
- 规划步骤可直接选择前置步骤（依赖编辑）
- 外部事件源：GitHub/飞书/CI 统一入口，externalId 幂等，助理自动 triage
- Webhook HMAC-SHA256 签名校验；未配置 secret 时开发模式放行
- 记忆混合检索：BM25 + 本地 hashed character n-gram 向量余弦，零外部依赖
- 死信：migration v31 attempts/maxAttempts，超限禁止执行与重试，提供 dead-letters API
- 死信重置：`/requeue` 清零 attempts、可提高 maxAttempts、回到 queued；UI 增加重置
- 私聊 LLM 检索 project/agent/private 记忆并注入上下文
- 记忆新增前相似冲突检测：向量+词法相似度，UI 支持替换旧记忆或仍然新增
- `autoResolveConflicts`：自动让相似旧事实过期；执行写入的 group/project 记忆默认启用
- 记忆 TTL：execution 30d / group 90d / private 180d；列表隐藏过期，支持 cleanup 清理
- Agent 并发上限：默认 2，`SPEC_AGENT_MAX_AGENT_CONCURRENCY` 可配；超限拒绝，完成后自动接续
- 项目级 ready 扫描：跨 Work Item / 群聊的 queued 任务在 Agent 释放后自动接续
- Outbox：migration v32，来源 Work Item 完成后生成 comment 回执，支持查询/标记发送
- Outbox Worker：v33 重试/退避/幂等唯一约束，log 或 HTTP transport，手动 run API
- GitHub 专用 Outbox transport：解析 issue/PR URL，调用 Comments API
- 群聊「出站」抽屉：状态筛选、运行队列、标记已发送、失败重试
- Outbox 单条发送：`/outbox/:id/send` + UI「发送」
- 迁移 v42：Outbox 发送审计，UI 可展开 attempt 记录
- Janitor 清理 Outbox 审计（保留天数可配）
- Outbox 审计 CSV 导出 + UI「导出审计」
- Outbox 待发送多选与批量「发送选中」
- Outbox「重试失败」批量重置 failed 回执
- 收敛范围：仅 GitHub 事件；隐藏记忆/规则配置入口，少即是多
- 极简工作台：只保留群聊/私聊，GitHub 回执后台自动发送，移除出站管理 UI
- GitHub 事件自动分派 assistant 并启动执行
- 打开项目直接进入群聊工作区，跳过旧会话列表
- GitHub webhook 只需 projectId，自动使用/创建 #GitHub 群聊
- 清理 12 个验证群、16 个测试 Work Item；数据库备份为 `spec-agent.db.bak-r84`
- 移除手动建群入口，GitHub 事件自动维护 #GitHub
- GitHub 事件跳过 LLM triage，直接建 Work Item 并自动执行
- 隐藏 Work Items 面板与手动建项按钮，改为双栏群聊时间线
- App 入口直接进入群聊工作区，移除旧会话列表/项目计划页面，JS 降至约 297 kB
- 删除 `ConversationWorkspace` / `ChatRail` / `ProjectPlans`，JS 进一步降至约 291 kB
- 重写 `SimpleGroupWorkspace`，删除 Work Items/手动操作代码，JS 降至约 276 kB
- 清理旧群聊/记忆/出站/规则/评论 CSS，CSS 降至约 169 kB
- 清理旧任务/计划/执行/时间线 CSS，CSS 降至约 129 kB
- GitHub 回执结果写入 outbox.sent/failed 事件，时间线可见
- GitHub Webhook `ping` 返回 200
- 群聊改为只读事件流，移除手动发消息输入框
- 时间线隐藏历史 assistant triage 消息
- 新增 `/api/github/webhook` 简洁入口（含 ping）
- mock GitHub API 验证评论发送：路径、Bearer 鉴权、正文均正确
- Webhook 不传 projectId 时自动使用最近项目
- GitHub `X-GitHub-Delivery` 幂等去重
- 跨 delivery 仍按 externalId 去重，避免同一 issue 重复建项
- ping 改为签名校验后返回
- 补 signed ping / unsigned ping 集成测试
- GitHub 回执新增 outbox.pending 事件，时间线显示排队
- pending 超过 1 分钟提示检查 GITHUB_TOKEN
- `/api/github/status` + 工作区回执状态提示
- GitHub 发送失败保留状态码/响应正文，便于诊断 token 权限
- mock 403 验证重试至 failed，时间线产生 3 条 outbox.failed
- 修复首屏 `chatProjects` 在组织 header 设置前请求导致空项目页的竞态
- GitHub 改为可选入口；手动聊天/任务恢复，无群聊时自动创建 #工作区，任务自动执行
- 组织下没有项目时自动创建默认项目，避免进入空等待页
- 恢复「组织 → 项目 → 群聊」层级；项目可无群聊直接打开，群聊改为手动新建
- 项目与群聊合并为单侧栏工作区树，参考工作区列表交互
- 工作区字号对齐 DSH：导航/项目 13–14px，时间线正文 13px，辅助信息 11–12px
- 群聊改为微信式左右气泡/头像/系统消息，发送栏和配色保持原有中性风格
- 用户消息气泡改为 DSH 同款淡蓝色（#dfe9ff）
- 左侧新增「组织」Agent 好友列表，点 Agent 在右侧内嵌私聊
- 群聊/私聊统一显示 Agent 名称（如「助理」）而不是内部 id（assistant）
- 群聊/私聊移除头像和私聊消息名称，头部只保留标题
- 内嵌私聊移除整行头部（标题/关闭按钮），直接显示消息
- 群聊移除顶部标题栏，和私聊一样直接显示消息
- 组织标题右侧改为 +，可原地创建平级 Agent（不设上下级）
- 助理私聊可创建组织 Agent；仍为 read-only，不能修改项目文件
- 私聊改为乐观发送：先显示用户消息/思考中，再流式输出；聊天区左右增加留白
- 私聊接入 reasoning 流并保存到消息 metadata，气泡内可展开「思考过程」
- Agent 创建指令支持「创建一个前端工程师agent」这类名称在前写法；私聊/群聊消息渲染 Markdown
- 组织 Agent 行去掉职责描述，只保留头像和名称
- 助理私聊接入本地 MCP `spec-agent-tools`：模型可调用 `create_agent` / `list_agents`，工具仅写 agents.yaml 并热加载
- 读取 Agent 列表时从文件热加载，修复默认组织 MCP 创建后 UI 不显示的问题
- 群聊支持把 Agent 拉进群：新增群成员 API/MCP `add_group_member`
- 群聊 triage 改为 MCP tool loop：`create_work_item` / `reply_in_group` / `add_group_member`；移除正则兜底
- 清理旧发行包、历史截图/文档、临时脚本、未引用前端组件与 Claude SDK 适配器
- 重构目录：Web 按 components/styles 分层；Server 按 http/work/chat/dsh/assistant/integrations/infra 分层
- `server.ts` 拆出 Work 与 Task HTTP 路由，降到约 1450 行
- `http/` 继续按 task-files、task-plans、chat-routes、errors、io 拆分
- HTTP IO、静态文件、上传与安全头抽到 `http/io.ts`，`server.ts` 降到约 1200 行
- Work 记忆路由抽到 `http/work-memory-routes.ts`，`work-routes.ts` 降到约 1100 行
- Work 群聊与 GitHub 路由继续拆到 `work-group-routes.ts`、`work-github-routes.ts`
- Work 路由完成分组：memory / group / github / outbox / item，`work-routes.ts` 只剩分发逻辑
- Agent 配置路由抽到 `http/agents-routes.ts`
- Chat 会话/项目草稿路由抽到 `http/chat-session-routes.ts`，`task-routes.ts` 降到约 640 行
- AI Assist 与任务查询/审批路由拆到 `http/ai-routes.ts`、`http/task-query-routes.ts`，`task-routes.ts` 只剩分发
- Chat 纯解析/校验函数抽到 `chat/parsers.ts`
- Work 领域类型与行映射抽到 `work/types.ts`、`work/rows.ts`，`work-store.ts` 降到约 1060 行
- Outbox 数据访问抽到 `work/outbox-repository.ts`，`work-store.ts` 降到约 830 行
- Source Rule 与评论/报告数据访问抽到 `work/source-rule-repository.ts`、`work/work-item-aux-repository.ts`，`work-store.ts` 降到约 620 行
- 记忆类型与检索/向量辅助函数抽到 `work/memory-types.ts`、`work/memory-ranking.ts`
- 记忆 BM25/向量混合打分抽成 `rankMemories` 纯函数
- Chat 持久化类型与 Row 映射抽到 `chat/store-types.ts`、`chat/store-rows.ts`，`chat-store.ts` 降到约 600 行
- ChatService 配置与 DTO 类型抽到 `chat/service-types.ts`
- Assignment 生命周期抽到 `work/assignment-service.ts`，`work-service.ts` 降到约 680 行
- Outbox 门面方法抽到 `work/outbox-service.ts`
- 记忆向量检索打分抽到 `rankVectorMemories`
- Chat 项目持久化抽到 `chat/project-repository.ts`，`chat-store.ts` 降到约 520 行
- ChangeSet/WorkflowDraft/ProjectPlanDraft 持久化抽到 `chat/draft-repository.ts`，`chat-store.ts` 降到约 360 行
- Session/Participant 持久化抽到 `chat/session-repository.ts`，`chat-store.ts` 降到约 220 行
- 任务记忆抽取协调器抽到 `chat/memory-extraction.ts`，`chat.ts` 降到约 1200 行
- 任务派发与项目计划草案动作抽到 `chat/task-dispatch.ts`、`chat/plan-draft-actions.ts`
- WorkflowDraft 与 ChangeSet 动作抽到 `chat/workflow-draft-actions.ts`、`chat/change-set-actions.ts`
- 助手回复落库、ChangeSet/Plan 解析与记忆写入抽到 `chat/assistant-result.ts`，`chat.ts` 降到约 960 行
- QA Prompt 与能力地图抽到 `chat/qa-prompt.ts`，`chat.ts` 降到约 860 行
- 模型路由与 @ 提及解析抽到 `chat/routing.ts`、`chat/mentions.ts`，`chat.ts` 降到约 800 行
- Agent 接力回复编排抽到 `chat/agent-replies.ts`，`chat.ts` 降到约 700 行
- 单 Agent 回合执行抽到 `chat/agent-turn.ts`，`chat.ts` 降到约 600 行
- `sendMessage` 主流程抽到 `chat/send-message.ts`，`chat.ts` 降到约 540 行
- Work 评论与 Source Rule 门面抽到 `work/comment-service.ts`、`work/source-rule-service.ts`
- Memory embedding 缓存、指标与向量存储抽到 `work/memory-embeddings.ts`，`work-memory.ts` 降到约 620 行
- 群聊与事件持久化抽到 `work/group-repository.ts`，`work-store.ts` 降到约 510 行
- WorkItem 与 Assignment 持久化抽到 `work/work-item-repository.ts`、`work/assignment-repository.ts`，`work-store.ts` 降到约 310 行
- 私聊线程/消息与群消息入口抽到 `work/private-message-service.ts`、`work/group-intake-service.ts`，`work-service.ts` 降到约 330 行
- 记忆过期清理与版本/向量维护抽到 `work/memory-maintenance.ts`，`work-memory.ts` 降到约 570 行
- Chat 会话/项目 CRUD 抽到 `chat/session-actions.ts`，`chat.ts` 降到约 470 行
- Project Plan tick/集成/verify 执行器抽到 `chat/project-plan-executor.ts`，`project-plans.ts` 降到约 240 行
- ChangeSet 自动续跑与会话详情抽到 `chat/change-set-actions.ts`、`chat/session-actions.ts`，`chat.ts` 降到约 420 行
- Memory 检索、候选加载、冲突与上下文集取抽到 `work/memory-retrieval.ts`，`work-memory.ts` 降到约 440 行
- Memory 写入、去重、冲突过期与版本写入抽到 `work/memory-writer.ts`，`work-memory.ts` 降到约 290 行
- 清理拆分后遗留的 Chat 无用导入/委托，`chat.ts` 降到约 385 行
- Assignment 调度抽到 `work/assignment-scheduler.ts`，`work-executor.ts` 降到约 235 行
- Outbox transport 实现与工厂抽到 `work/outbox-transports.ts`，`outbox-worker.ts` 降到约 100 行
- 私聊线程持久化与 agent 执行历史抽到 `work/private-thread-repository.ts`、`work/assignment-repository.ts`，`work-store.ts` 降到约 220 行
- 启动恢复：running Assignment 重启后退回 queued 并重新调度
- GitHub 原生 webhook 适配：issues / issue_comment / pull_request，query 映射项目群聊
- GitHub action 白名单：默认忽略 edited/closed；`SPEC_AGENT_GITHUB_ACTIONS` 可配
- PR review / review comment 归一化，默认接收 `submitted`
- Review comment Outbox 使用 `in_reply_to` 回复 PR thread
- Outbox 回执保留来源 URL；修复 review 回执缺少 URL 的问题
- 迁移 v34 + source 规则 API：按项目/群聊配置 actions/enabled，覆盖全局白名单
- 迁移 v35：规则支持 labels/authors 过滤，UI 增加对应输入
- Work Item 评论：迁移 v36，API + 详情评论列表/输入，写 workitem.commented 事件
- 评论可同时创建 Assignment（「同时交给助理执行」），自动进入调度
- ContextAssembler 注入最近 Work Item 评论，评论指令进入 Agent 上下文
- 评论派单支持选择任意 Agent
- 评论正文解析 `@Agent` 自动派单
- 评论编辑/删除（migration v37），写 updated/deleted 事件
- OpenAI 兼容 Embedding Provider；私聊记忆检索走 searchAsync + 向量缓存
- 迁移 v38：embedding 向量持久化，重启不重复请求
- ContextAssembler.assembleAsync：WorkExecutor 上下文也使用向量检索
- 向量运维：stats/cleanup API，记忆面板显示调用/失败/向量数
- MemoryJanitor：启动时与每小时清理过期记忆/旧向量
- 记忆作用域写入校验：project/group/org 归属，agent scopeId 自动作为 agentId
- 记忆面板支持创建 Agent 作用域记忆
- 记忆面板支持 Agent 私聊（private）作用域，自动解析线程
- 记忆原地编辑 API/UI，与「替换」supersede 并存
- 迁移 v39：记忆版本历史，编辑前自动留存，UI 可查看
- 记忆版本回滚 API/UI，恢复前再存当前版本
- 记忆版本行级 diff API/UI
- 记忆版本清理：每条记忆保留最近 N 条，UI/API 入口
- Janitor 自动清理记忆版本（保留天数与条数可配）
- 迁移 v40：embedding 调用/失败指标持久化
- 记忆搜索 API 切换 searchAsync，面板搜索也能用外部 embedding
- 记忆编辑并发冲突：expectedUpdatedAt 不一致返回 409
- 迁移 v41：embedding 指标按项目分桶，面板显示本项目调用数
- Work Item 优先级编辑，自动调度按 priority 降序
- 群聊「规则」抽屉：规则列表、编辑来源/作用域/actions、启停、删除
- 私聊流式：SSE status/delta/done，ChatEngine onDelta 推送，完成后落库
- 完成报告以事件卡片回到群聊并 @ 发起人
- Assignment 完成/阻塞产生 report 事件并 @ 发起人；事件支持 dedupe 幂等
- 下一步接 HTTP API、群聊 UI、助理 triage 和 DSH 执行器

### 会话优先工作台

- 顶层改为组织：组织管理 Agent 配置，组织内管理多个独立项目
- 每个项目自动创建独立目录与 Git 仓库，任务写入项目 `repoPath`
- 左侧改为 项目列表 → 会话树；组织在首页选择，进入组织后不再提供组织切换
- 首页改为纯组织管理：组织列表、创建/打开/归档，移除 hero 文案和目标 composer
- 工作流草案记录项目 `repo_path`，确认后任务落在对应项目
- 项目计划归属到项目：`project_plans.project_id`，列表/创建/详情按项目过滤，计划任务默认使用项目仓库
- 会话通过 `project_id` 归属项目；旧 `chat_projects` 数据迁移自 `chat_subprojects`
- 项目支持新建、展开、删除；删除后会话进入「未归属」
- 新会话/单聊归属当前项目
- 每个项目可建多个会话；新会话自动加入助理
- 左侧支持组织切换、项目展开、会话列表、参与 Agent、拉入 Agent、单聊、组织编辑
- 每个 Agent 支持 direct 单聊；默认由 `primaryAgentId` 回复
- `@agent` 路由：文本 `@名称` 或 mentions 选择器
- Agent 间 @ 接力，最多 3 次回复，禁止回到已参与 Agent
- 显式「并行」时首批 @Agent 并发，结果按 @ 顺序落库；接力仍串行
- 每个 Agent 在会话内持久化独立 SDK session
- 连续 3 条以上 Agent 回复自动成组折叠；组内按 sender+content 去重、按 createdAt 排序
- 支持逐条收起/展开和一键折叠全部 Agent 回复

### WorkflowDraft 与任务

- 任务模式先生成 WorkflowDraft，确认后才创建 Task
- 右侧上下文支持草案确认/放弃
- 完整任务面板内支持：
  - 状态/成本/节点进度
  - 内联审批（批准/打回）
  - 计划节点 agent/审批/指令编辑
  - 节点增删、依赖增删
  - 产物预览
  - commit / patch / 单文件预览
  - 执行记录、子任务、合并队列
- 支持 `?task=<id>` 和 `&expand=1` 深链

### 首页与移动端

- 首页改为纯组织管理：组织列表、创建/打开/归档，移除 hero 文案和目标 composer
- Agent 私聊独立于项目：点击 Agent 行直接在中间打开私聊，不进入项目会话树，不显示问答/任务切换，不占用右侧上下文
- Agent 区改为树形：层级缩进、三角折叠下级、行尾 `⋯` 菜单（拉入/编辑/删除/新建下级），顶部 `+` 新建顶层 Agent
- 供应商弹窗去掉「默认供应商/默认模型」选择；保存时自动取第一个 Anthropic 兼容供应商的第一个模型
- 群聊 `@Agent` 使用群聊基础层 + 该 Agent 自定义提示词；私聊仍使用私聊基础层
- 群聊 Copilot 使用助理 Agent 的自定义提示词；私聊 Agent 使用各自自定义提示词，后台基础层不可见
- Agent 创建弹窗模型去掉「继承默认」，默认选中第一个可用模型；编辑历史继承值也归一为第一个模型
- Agent 顶部 `+` 改为单 Agent 创建弹窗：名称/职责留空，默认顶层，保存追加到组织，不再展示全部 Agent
- Agent 计数紧贴标题；顶层 Agent 与左边框对齐；移除项目/Agent 区多余提示
- 所有表单控件与按钮统一到 UI 组件：Button（含 plain 布局变体）/ Input / Textarea / Select / Checkbox；原生 button/input/textarea/select 已清零
- 单聊不再依赖项目：没有项目也能直接和 Agent 单聊，会话进入未归属列表
- 侧栏 Agent 数改为组织 Agent 数；无会话时显示 Agent 列表和操作提示，单聊在无项目时禁用
- 新建可管理组织自动写入默认「助理」Agent（只读工具），侧栏标签由「参与 Agent」改为「Agent」
- 修复无项目/无会话时「参与 Agent」永久显示“正在加载”；空状态改为先创建项目
- 修复 Dialog 每次父组件重渲染都把焦点抢回面板，导致组织名只能输入一个字符
- 本地 `serve`/`dev:server` 使用 `.spec-agent/projects.json` 可写注册表，首页「新建组织」可见
- ≤760px 单栏对话；会话/上下文改为左右全高抽屉
- 移动端首页组织列表单列；修复横向溢出和顶栏换行

### 数据与兼容

- migration v19：conversation kind / participants / sender / mentions
- migration v20：WorkflowDraft
- migration v21：每个 Agent 的 conversation session
- migration v22：`chat_subprojects` 与会话 `subproject_id`（v23 已重构）
- migration v23：`chat_projects` + `root/repo_path`、`chat_sessions.project_id`、`chat_workflow_drafts.repo_path`
- migration v24：`project_plans.project_id`
- migration v25：`chat_sessions.permission_mode`（默认 `read-only`）
- 旧任务页与旧任务状态/加载链已删除
- Web 端 `noUnusedLocals / noUnusedParameters` 为 0

### 验证

- 全量：75 files / 606 tests
- 覆盖率：90.3% branches
- `pnpm typecheck`、`pnpm build:web` 通过
- 移动端 390×844 CDP 实测 `scrollWidth=390`
- release 包用内置 runtime 启动，`/api/health` 与 `/` 均返回 200





































