# 相关工作与最佳实践调研

> 目的：在动手写代码前，搞清楚这个问题上别人已经走到哪、哪些做法已经是共识、Hive 还剩什么空间。
> 调研日期：2026-10-26。Star 数是当天的 GitHub API 快照，只作量级参考。
> 结论会直接改 `design.md`，所以本文只写有工程含义的东西。

---

## 0. 如果只记三件事

1. **"层级 agent + 定向通信"已经有人做了**（Agency Swarm 的 communication flows、CrewAI 的 hierarchical process、MetaGPT 的 SOP）。这不是空白，别把它当创新点。
2. **人审的持久化暂停/恢复已经是标准答案**（LangGraph 的 `interrupt()` + checkpointer、Temporal 的 Signal、OpenAI Agents SDK 的 `RunState`）。直接对齐它们的语义，不要自创一套。
3. **真正的空白只剩两块**：① 把 git 提交追溯到 task/node/agent 的**归属链**；② 强制"终端产物必须经过验证"的**闸门规则**。这两块没人做，而且是大型项目里最贵的漏洞。

---

## 1. 调研范围

查了六类东西：

- **图/状态机编排**：LangGraph、Mastra、Microsoft Agent Framework
- **持久化执行**：Temporal（及 LangGraph 插件）、Mastra 的 suspend/resume
- **角色组织**：CrewAI、MetaGPT、Agency Swarm
- **事件驱动 actor**：AutoGen 0.4、Microsoft Agent Framework
- **单 agent + 子 agent 隔离**：Claude Code subagents、OpenAI Agents SDK、OpenHands
- **并行编码 agent 的工作区隔离**：Dagger container-use、Claude Code `isolation: worktree`、timberline / swarmgit 这类 worktree 管理器
- **平台级动向**：GitHub Agent HQ

另外交叉参考了 AFlow、Agent Workflow Memory、MAST 失败分类和那篇瀑布式协作的实证。

---

## 2. 六条技术路线

### 2.1 图编排：把 agent 写成图

**代表**：[LangGraph](https://github.com/langchain-ai/langgraph)（约 43.9k stars，MIT）、[Mastra](https://mastra.ai/docs/workflows/suspend-and-resume)、Microsoft Agent Framework 的 workflows。

核心抽象：state + node + edge + checkpointer。节点读写共享 state，边决定流向，checkpointer 每个 super-step 落一次快照。

**人审怎么做**（LangGraph）：

- 节点里调 `interrupt(payload)`，图暂停，值返回给客户端
- 恢复时用 `Command(resume=value)`，**节点会从头重新执行**，所以 `interrupt()` 之前的副作用必须幂等
- 生产环境必须用**持久化** checkpointer，不能用内存版

**和 Hive 的关系**：Hive 的 `WorkflowSpec` + `node_run` + `checkpoint_ref` 是同一套东西，只是把"图"换成了"任务树里的 DAG"。**语义应该直接对齐，不要另发明一套。**

### 2.2 持久化执行：把"等人"变成基础设施

**代表**：[Temporal](https://docs.temporal.io/ai/cookbook/human-in-the-loop-python)、Mastra 的 suspend/resume。

Temporal 的模型：workflow 是确定性的、可重放的函数；审批通过 **Signal** 注入；等待用 `workflow.sleep()` 这种 durable timer，"进程崩了三天后重启，仍然停在第 3 天"。LangGraph + Temporal 插件做的事情很说明问题：

> `interrupt()` 时 workflow 持久暂停，**不占着进程**；人一小时后、甚至一个月后响应，Signal 恢复，"暂停范围只限于需要审的那个分支"。

Mastra 的形态更轻：任何 step 都能 `suspend()`，返回值里带 `suspended` 数组，`resume()` 从暂停点继续。挂起原因可以是人、外部回调或定时。

**和 Hive 的关系**：你们的 `gates` 表 + 事件日志就是同一个思路。需要补的是：**提醒和升级要用 durable timer，不能用进程内的 `setTimeout`**。

### 2.3 角色组织：把公司结构写进代码

**代表**：[CrewAI](https://github.com/crewAIInc/crewAI)（约 60.1k stars）、[MetaGPT](https://github.com/FoundationAgents/MetaGPT)（约 71k stars）、[Agency Swarm](https://github.com/VRSEN/agency-swarm)（约 4.6k stars）。

**CrewAI 的 hierarchical process**：定义一个 `manager_agent`（或 `manager_llm`），它负责规划、委派、验收；委派是通过 `allow_delegation=True` 暴露成一个普通工具调用。任务默认不是预先分配的，manager 在运行时决定。

这里有个值得注意的批评：CrewAI 的层级"**只是 manager 的一个 turn，不是运行前的调度器**"——委派发生在 manager 的对话回合里，所以流程不可预先审查（[来源](https://github.com/sandgardenhq/dh-library/blob/6e076f95ec7efe3f5ec84ab0622540ea460c3ff7/content/en/crewai/04-the-hierarchical-process.md)）。

**这正是 Hive 的位置**：你们把委派做成 DAG 节点，流程在跑之前就是可审查、可校验、可显示的。这个区别值得反复强调。

**MetaGPT** 的哲学是 `Code = SOP(Team)`：产品经理 → 架构师 → 项目经理 → 工程师，每个角色消费上游的结构化产物。它证明了"角色分工 + 结构化交接"能跑通 demo，但也暴露了问题：**固定 SOP 不会因为任务大小而伸缩**——这恰好是 Hive 用"动态组装"想解决的。

**Agency Swarm** 是撞车最严重的一个：`Agency` 上用 `communication_flows=[(ceo > dev), (dev > qa)]` 这种**有向边**声明谁能跟谁说话，agent 之间通过 `send_message` 工具通信，甚至支持自定义 flow 类（比如 `Handoff`）。

和 Hive 的差别：Agency Swarm 的通信是**同步的工具调用**，没有任务树、没有持久化、没有产物归属、没有图级校验。它解决的是"让多个 agent 能互相喊话"，你们解决的是"让一次交付可审计"。

### 2.4 事件驱动 actor：AutoGen 那一支

**代表**：[AutoGen 0.4](https://devblogs.microsoft.com/autogen/autogen-reimagined-launching-autogen-0-4/)（约 61.6k stars）。

0.4 是一次重写：Core 层是**异步事件驱动的 actor 运行时**，agent 之间发消息；AgentChat 层在其上提供任务驱动的高层 API。微软随后把 AutoGen 和 Semantic Kernel 合并成了 [Microsoft Agent Framework](https://atlan.com/know/ai-agent/microsoft/agent-framework/)（据说 2026 年 4 月发 1.0），补上了图工作流、checkpoint、类型安全。

**和 Hive 的关系**：你们的"事件日志 + 任务树 + 消息"其实是 actor 模型的一个受限子集——好处是约束强、可审计，坏处是表达力弱。**可以借它的一个做法：把 agent 间消息也当成一等事件**，而不是塞进某个 run 的日志里。

### 2.5 单 agent + 子 agent：2026 年的主流答案

**代表**：Claude Code 的 subagents、OpenAI Agents SDK 的 handoffs、OpenHands。

Claude Code 的文档写得很直白：subagent 的价值是**上下文隔离**——"上下文窗口是全新的，父会话什么都不传，除了 Agent 工具的那一个 prompt 字符串"；而且现在已经支持 `isolation: worktree`，让 subagent 在自己的 worktree 里跑命令（[文档](https://code.claude.com/docs/en/sub-agents)）。还有一句值得贴在墙上：

> "subagents are a great context-isolation primitive, not a magic productivity wand."

**这是对"多 agent 更聪明"最有力的反驳。** 你们的角色分工如果不能在"上下文容量、并行、审计"这三件事上给出增量，就只是把同一个模型复制了几份。

OpenAI Agents SDK 的做法不同：工具声明 `needs_approval`，运行到那里就停，`result.interruptions` 里带着待批项，`RunState` 可以序列化、之后恢复（[文档](https://openai.github.io/openai-agents-python/zh/human_in_the_loop/)）。**审批粒度是工具级，不是节点级**——这比 Hive 更细，值得借鉴。

### 2.6 工作区隔离：并行 agent 的物理基础

**代表**：[Dagger container-use](https://github.com/dagger/container-use)（约 4.1k stars）、Claude Code 的 worktree 隔离、[timberline](https://pypi.org/project/timberline/) / swarmgit / opentree 这类 worktree 管理器。

container-use 的定位很准确：**给每个 coding agent 一个独立的容器 + 独立 git 分支**，让多个 agent 能安全地并行改同一个仓库。worktree 那一类工具解决的是同一件事的更轻量版本，外加"每个 worktree 一份 agent 配置"。

**和 Hive 的关系**：你们"每任务一个 worktree"的选择是对的，而且已经在被商品化——**这不再是差异化，是基础设施**。差异化只能在"worktree 之上的归属"。

---

## 3. 横向对比

| 能力 | 谁做得好 | 成熟度 | Hive 的差异 |
|---|---|---|---|
| 图/DAG 编排 | LangGraph、Mastra | 成熟 | 无本质差异 |
| 持久化暂停/恢复 | Temporal、LangGraph、Mastra | 成熟 | 无本质差异 |
| 人审 | 上述三家 + OpenAI SDK | 成熟 | 多一层"自动闸门" |
| 角色分工 | CrewAI、MetaGPT | 成熟 | 流程可预先审查 |
| 定向通信 | Agency Swarm | 成熟 | 多了持久化与审计 |
| 子 agent 上下文隔离 | Claude Code、OpenAI SDK | 成熟 | 用文件接口，比 prompt 传递强 |
| worktree / 容器隔离 | container-use、Claude Code | 成熟 | 多了 commit 归属 |
| 并行 agent 调度台 | GitHub Agent HQ | 新兴 | 平台 vs 本地 |
| workflow 自动生成 | AFlow、AWM | 研究阶段 | 工程化校验 + 晋升 |
| **commit → task 归属** | **没有** | **空白** | ★ |
| **未验证产物拦截** | **没有（框架层）** | **空白** | ★ |
| **workflow 作为可复用 artifact** | 部分（AWM 的 memory） | 半空白 | ★ |

---

## 4. 十二条已经形成共识的做法

写成清单，是因为这些**不该再争论，直接照做**。

1. **状态必须可持久化恢复**。内存里的 `while waiting_for_human` 是错误答案，2026 年没有例外。
2. **人审 = 中断 + 恢复**，不是阻塞调用。恢复时要么从检查点继续，要么重跑幂等节点。
3. **中断之前的副作用必须幂等或可回滚**。LangGraph 文档专门警告这一条，因为节点恢复时会从头执行。
4. **子 agent 只接受最小输入**：一个 prompt 或几个 artifact 引用，不是整段对话历史。
5. **交接用结构化产物**，不是自由文本。CrewAI 的 task output、MetaGPT 的 document、Hive 的 artifact 是同一个思路。
6. **权限靠工具白名单，不靠提示词**。
7. **可观测性独立成层**：trace / span / 成本，不要混在业务日志里。
8. **人审的动词不止"通过/拒绝"**。LangChain 的 HITL 中间件把它规范成四个：`approve` / `edit` / `reject` / `respond`。
9. **默认单 agent**。只有上下文隔离、并行、审计三件事有明确收益时才拆多 agent。
10. **委派必须有深度上限和预算上限**，否则分支爆炸。
11. **不要把"软件公司流水线"当成默认架构**。有实证显示瀑布式协作会降低功能正确率（GPT-4o-mini −37.8%，DeepSeek-Chat −39.8%）。
12. **审批界面要给 diff，不要给自述**。

---

## 5. 六个反模式

| 反模式 | 谁踩过 | 后果 |
|---|---|---|
| 群聊式多 agent（所有 agent 在一个频道里） | AutoGen GroupChat、各类 demo | 上下文互相污染、成本高、不可预测 |
| manager 在运行时自由委派 | CrewAI hierarchical | 流程不可预先审查，出了问题无法复现 |
| 固定 SOP 不分任务大小 | MetaGPT | 小任务也要走全流程，成本失控 |
| 内存里等人审 | 大量自研项目 | 重启即丢，长任务无法交付 |
| 多个 agent 共用一个工作树 | 早期并行方案 | 互相覆盖、无法归因 |
| 只靠 prompt 约束权限 | 大量 demo | 一句注入就绕过了 |

---

## 6. 和 Hive 的逐项对照

### 6.1 已经撞车的（不要当创新点写）

| Hive 的设计 | 已有实现 | 建议 |
|---|---|---|
| agent 上下级 + 只能定向通信 | Agency Swarm `communication_flows` | 直接引用，说明差异是持久化 + 归属 |
| 层级委派 | CrewAI hierarchical | 强调"委派是 DAG 节点，不是运行时 tool call" |
| 人审闸门 + 恢复 | LangGraph `interrupt`、Temporal Signal | 对齐语义，别自创 |
| workflow 节点无记忆 | 所有 DAG 引擎 | 这是 DAG 的默认语义，不算设计 |
| 每任务 worktree | container-use、Claude Code | 当基础设施用，别当卖点 |
| 并行多 agent 调度 | GitHub Agent HQ（2025-10） | 平台已占位，避开 |

### 6.2 还是空白的（可以压上去）

**① commit → task 的归属链**

调研里没有任何一个项目把"这次提交属于哪个任务、哪个节点、哪个 agent、经过谁审批"做成结构化的、可查询的事实。container-use 有 branch per agent，Claude Code 有 worktree，但**没有一层把 blame 映射回 task**。

这一条在大型项目里是刚需：出了线上事故，你要回答的不是"哪个 agent 写的"，而是"哪个需求、哪次审批、哪个测试没拦住"。

**② 未验证产物拦截**

MAST 把多 agent 的失败分成三类，其中一类就是 **task verification**。但所有框架都把验证当"用户自己接一个测试工具"，没有人在编排层强制"这个产物必须有人验过"。

Hive 的 `E_UNVERIFIED_ARTIFACT` 是规则层的东西，不是功能层的东西——**这正是论文里可以主张的贡献**：不是"我加了个测试节点"，而是"我把可验证性变成了编排的合法性条件"。

**③ workflow 作为可复用、可校验、可晋升的 artifact**

AFlow 是在 workflow 空间里搜索最优解（MCTS），Agent Workflow Memory 是从经验里归纳可复用流程。两者都是"生成"，没有人做**工程化的一生**：hash 化、版本化、七道校验、人审通过后晋升为模板、老 run 可复现。

**④ delegate 作为图节点**

把"通知某个 agent"画进 DAG，使整条交付流程在运行前可审查。CrewAI 是运行时委派，Agency Swarm 是同步工具调用，都不是图。

### 6.3 组合本身也是差异

单独看每一条都有先例，但 **"组织 + 图 + 归属 + 闸门"四者交叉**没有人做。这是 Hive 唯一站得住的整体主张，也是论文里应该反复收束的那句话。

---

## 7. 可以直接借的十个机制

按 `design.md` 的章节给，拿来就能改。

**1. 人审四动词（§12.3）**

现在只有通过/拒绝。LangChain 的实践是四个：`approve`（照原样继续）、`edit`（改完再继续）、`reject`（打回重做）、`respond`（补充信息，不改变产物）。你们的 `waiting_input` 其实就是 `respond`，应该合并进闸门语义。

**2. "中断前的副作用必须幂等"（§12、§13.2）**

写进硬约束：任何节点在被闸门拦住之前完成写入，必须满足"重跑一次结果不变"，或者有 checkpoint 可回滚。这是 LangGraph 用血换来的教训，能省掉大量诡异 bug。

**3. 提醒用 durable timer（§12.4）**

`remind_after` 不是 `setTimeout`，是一条带到期时间的记录，进程重启后仍然有效。Temporal 的 `workflow.sleep()` 就是这个思路。

**4. 整个 run 的可序列化快照（§13.2）**

OpenAI SDK 的 `RunState` 可以序列化整个暂停中的运行。Hive 有 task + run + node_run 三层，需要定义"恢复到哪一层"，别只恢复节点。

**5. 通信流用声明式边（§8.5）**

Agency Swarm 的 `(sender > receiver)` 比 `can_delegate_to: [fe, be]` 表达力强，因为它可以带类型（普通消息 / 交接 / 提问）。建议改成：

```yaml
flows:
  - {from: pm, to: fe, kind: delegate}
  - {from: fe, to: pm, kind: report}
  - {from: fe, to: be, kind: question, via: lca}
```

**6. 工具级审批（§12.3）**

节点级闸门太粗：一个 `implement` 节点里可能有 20 次工具调用，只有 `git push` 和 `rm -rf` 需要人批。可以两层都有，但工具级是默认更实用的那个。

**7. trace 用 OpenTelemetry GenAI 语义约定（§14.3）**

别自造 span 格式。用现成约定，能直接接 Langfuse、Phoenix、Jaeger 这类后端，省掉整个 UI 的一半。

**8. 子 agent 定义做成文件（§10.1、§16.1）**

Claude Code 把 subagent 写成 `.claude/agents/*.md`（YAML frontmatter + 正文），用户可以直接手写、版本化。Hive 已经有 `agents/*/agent.yaml`，可以再进一步：`description` 字段写好，让顶层 agent 能**自动判断该派给谁**。

**9. worktree 的依赖预热（§5.6）**

container-use 用容器解决环境隔离，代价是重。你们用 worktree，代价是每个都要装依赖。可以借"预热 + 快照"的思路：建 worktree 时从模板目录硬链接 `node_modules`，而不是重新 install。

**10. 审批收件箱可插拔（§14.2）**

GitHub Agent HQ 把"分配任务 / 跟踪 / 审批"做成了一个控制台；HumanLayer 把审批做成 API + Slack/邮件通道。Hive 的收件箱可以只做核心，但通道要可插拔——否则你迟早要接企业微信。

---

## 8. 对 design.md 的修订清单

按优先级：

| 优先级 | 改动 | 位置 |
|---|---|---|
| P0 | 人审四动词，`respond` 并入闸门 | §12.3 |
| P0 | 明确"中断前副作用必须幂等/可回滚" | §12、§13.2 |
| P1 | 提醒/升级改 durable timer | §12.4 |
| P1 | 通信改成声明式 `flows` | §8.5 |
| P1 | 新增"要不要直接基于 LangGraph/Temporal"的决策记录 | §5、§24 |
| P2 | 工具级审批作为可选项 | §12.3 |
| P2 | trace 对齐 OpenTelemetry GenAI | §14.3 |
| P2 | worktree 依赖预热方案 | §5.6 |

其中**最该先决定的是 P1 那条**：自研引擎 vs 基于 LangGraph。见下一节。

---

## 9. 一个必须现在决定的分叉：自己造，还是站在别人肩上

调研完之后，这个问题的答案比之前清楚了。

**选项 A：自研引擎（当前设计）**

- 优点：状态机语义完全可控，事件日志和 git 归属能长在一起，论文里"系统实现"这一章有内容
- 缺点：Temporal/LangGraph 已经踩过的坑，你要再踩一遍；M1 至少多花一周
- 适合：把"引擎"本身当作研究产出的一部分

**选项 B：LangGraph 做图 + 持久化，Hive 只做上层**

- 优点：省 2–3 周，checkpoint/interrupt 直接用，生态成熟
- 缺点：任务树、闸门、归属要架在它的 state 上，受它的抽象约束；论文的"系统贡献"会被削弱（评委会问"这不就是 LangGraph 加壳"）
- 适合：目标是产品而不是论文

**选项 C：Temporal 做 durable，Hive 只写编排**

- 优点：工业级可靠性
- 缺点：重，本地单机体验差，`WorkflowSpec` 要翻译成 Temporal 的代码/DSL，动态组装的表达能力受限
- 结论：v1 不选

**我的建议**：M0–M2 自研，但**所有语义对齐 LangGraph**（`interrupt`/`resume`/checkpoint/四动词），把代码写成"以后能换引擎"的形状。如果到 M3 发现引擎拖累了进度，再切 B——那时候你已经知道需要哪些语义，切换成本可控。

这个决定应该作为一条 ADR 写进 `design.md`，而不是留在脑子里。

---

## 10. 对定位的影响

**产品层面**：GitHub Agent HQ（2025-10）已经把"分配一队 agent 并行干活 + 审批"做成了平台能力，还接入了 Anthropic、OpenAI、Google、Cognition、xAI 的 agent。**在"调度别人的 agent"这件事上不要竞争**，你赢不了，也没必要。

能站住的位置只有两个：

- **本地、可自托管、与 git 深度绑定的可审计 runtime**（企业不让代码出内网）
- **垂直场景的交付流水线**（验证便宜、输出结构化）

**论文层面**：调研反而帮了大忙。你的三个主张现在都有明确的"前人做到哪"作为参照：

1. 归属链——前人没做
2. 验证强制——前人没做（MAST 证明这是真痛点）
3. workflow 工程化——前人只做生成，没做生命周期

而"层级 agent 编排"这一条，正好用瀑布式实证做反衬：**已有研究说层级可能降低正确率，所以本文要回答的是"在什么条件下不降低，以及代价是什么"**。这个张力比"我做了个多 agent 框架"值钱得多。

---

## 11. 参考

**框架与运行时**

- LangGraph — https://github.com/langchain-ai/langgraph
- LangGraph 人工介入 — https://mintlify.wiki/langchain-ai/langgraph/concepts/human-in-the-loop
- Mastra suspend/resume — https://mastra.ai/docs/workflows/suspend-and-resume
- AutoGen 0.4 — https://devblogs.microsoft.com/autogen/autogen-reimagined-launching-autogen-0-4/
- Microsoft Agent Framework — https://atlan.com/know/ai-agent/microsoft/agent-framework/
- CrewAI hierarchical — https://docs.crewai.com/v1.15.30/en/learn/hierarchical-process
- MetaGPT — https://docs.deepwisdom.ai/v0.4/zh/guide/get_started/introduction.html
- Agency Swarm 通信流 — https://agency-swarm.ai/core-framework/agencies/communication-flows

**人审与持久化**

- Temporal HITL — https://docs.temporal.io/ai/cookbook/human-in-the-loop-python
- Temporal × LangGraph 插件 — https://temporal.click/blog/temporal-langgraph-plugin-durable-execution
- OpenAI Agents SDK HITL — https://openai.github.io/openai-agents-python/zh/human_in_the_loop/
- HumanLayer SDK — https://www.npmjs.com/package/@humanlayer/sdk

**编码 agent 与隔离**

- Claude Code subagents — https://code.claude.com/docs/en/sub-agents
- Claude Code Agent SDK subagents — https://code.claude.com/docs/en/agent-sdk/subagents
- Dagger container-use — https://github.com/dagger/container-use
- timberline（worktree 管理）— https://pypi.org/project/timberline/
- GitHub Agent HQ — https://github.blog/news-insights/company-news/welcome-home-agents/

**研究**

- AFlow（ICLR'25）— https://proceedings.iclr.cc/paper_files/paper/2025/hash/5492ecbce4439401798dcd2c90be94cd-Abstract-Conference.html
- Agent Workflow Memory（ICML'25）— https://dl.acm.org/doi/10.5555/3780338.3782875
- MAST 失败分类（NeurIPS'25）— https://proceedings.neurips.cc/paper_files/paper/2025/hash/b1041e52d3be19f0a9bc491657488e4a-Abstract-Datasets-and-Benchmarks-Track.html
- 瀑布式过程模型实证 — https://huggingface.co/papers/2511.09794
