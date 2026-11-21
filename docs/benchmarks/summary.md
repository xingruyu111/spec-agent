# Session 模式与功能开销基准（完整版）

生成时间：2026-11-08  
环境：Windows / Node 24 / pnpm；DeepSeek 官方 API；Hy-Memory 2.0.14。

## 0. 测量矩阵

| 项目 | 覆盖 |
|---|---|
| 模型 | `deepseek-flash`、`deepseek-v4-pro` |
| 协议 | Anthropic-compatible、OpenAI-compatible |
| 工作流 | 3 节点 5 轮、6 节点 3 轮、4 节点 2 轮 |
| 质量 | 4 道语义题 ×2 轮；3 步上下文依赖 ×2 轮 |
| 并发 | 5 个 session ×3 次调用 |
| fork | 3 轮 fork vs 新 session |
| 恢复 | checkpoint、reset+clean 各 20/100 次 |
| Hy | lite add/search 5 组；pro + working/coding 各 1 组 |
| 测试 | 62 文件 / 520 测试 |

## 1. 3 节点 ×5 轮（deepseek-flash）

| 指标（每轮） | node 中位数 | session 中位数 | 变化 |
|---|---:|---:|---:|
| 费用 | $0.142560 | $0.054299 | **-61.9%** |
| 输入 tokens | 35,565 | 12,335 | **-65.3%** |
| cache read | 0 | 23,296 | — |
| 耗时 | 8,682 ms | 7,998 ms | **-7.9%** |
| 成功 | 15/15 | 15/15 | 持平 |

原始数据：[real-session-ab.json](real-session-ab.json)

## 2. 6 节点 ×3 轮（deepseek-flash）

| 指标（每轮） | node 中位数 | session 中位数 | 变化 |
|---|---:|---:|---:|
| 费用 | $0.290660 | $0.063662 | **-78.1%** |
| 输入 tokens | 71,148 | 12,798 | **-82.0%** |
| cache read | 0 | 58,752 | — |
| 耗时 | 16,663 ms | 14,458 ms | **-13.2%** |
| 成功 | 18/18 | 18/18 | 持平 |

节点变长后，session 的成本优势从 62% 增至 **78%**。  
原始数据：[real-session-flash-6nodes.json](real-session-flash-6nodes.json)

## 3. 4 节点 ×2 轮（deepseek-v4-pro）

| 指标（每轮） | node 中位数 | session 中位数 | 变化 |
|---|---:|---:|---:|
| 费用 | $0.192128 | $0.060325 | **-68.6%** |
| 输入 tokens | 47,912 | 12,232 | **-74.5%** |
| cache read | 0 | 35,904 | — |
| 耗时 | 11,507 ms | 13,118 ms | **+14.0%** |
| 成功 | 8/8 | 8/8 | 持平 |

v4-pro 的成本仍然明显下降，但延迟反而变差；这是推理模型输出/思考长度差异，不是缓存问题。  
原始数据：[real-session-v4pro-4nodes.json](real-session-v4pro-4nodes.json)

## 4. 语义质量与上下文质量

2 轮，每轮 4 道语义题 + 1 组 3 步上下文任务。

| 测试 | node | session |
|---|---:|---:|
| 语义题准确率 | **8/8 (100%)** | **8/8 (100%)** |
| 3 步依赖召回 | **0/4 (0%)** | **4/4 (100%)** |
| 语义题费用 | $0.352984 | $0.386193 |
| 依赖任务费用 | $0.303760 | $0.294257 |

结论：短独立语义题两种模式都正确，session 没有质量损失；需要跨步骤记忆时 session 明显占优，node 模式按设计没有前序上下文。  
原始数据：[quality.json](quality.json)

注意：依赖召回是“会话上下文保持”测试，不是通用语义能力评测。

## 5. 并发压力

5 个 session 并发，每个 3 次调用，共 15 次：

| 指标 | 结果 |
|---|---:|
| 成功 | **15/15** |
| 失败 | 0 |
| 墙钟时间 | 15.10 s |
| 单调用中位数 | 4.47 s |
| 单调用 p95 | 6.09 s |
| 总费用 | $0.8003 |

第一次 5 并发运行遇到额度/限流失败，已排除；这是恢复额度后的结果。  
原始数据：[concurrency.json](concurrency.json)

## 6. Fork vs 新 session

3 轮，每次 fork/新 session 都需要回答“刚才的代号”：

| 指标 | fork | 新 session |
|---|---:|---:|
| 成功率 | 3/3 | 3/3 |
| 正确包含代号 | **3/3** | **0/3** |
| 中位耗时 | 2,728 ms | 5,388 ms |
| 总费用 | $0.291870 | $0.179940 |
| cache read | 0 | 0 |

fork 保留了父上下文，因此质量正确；费用更高，因为输入包含父会话上下文。新 session 更便宜但无法完成任务。  
原始数据：[fork.json](fork.json)

## 7. Checkpoint 与恢复

| 操作 | 中位数 | p95 |
|---|---:|---:|
| checkpoint（单 ref） | 117.3 ms | 128.3 ms |
| reset + clean 恢复 | 202.9 ms | 257.9 ms |
| 单 LLM 节点 before+after | 约 234 ms | — |
| 一次完整回滚（checkpoint + restore 不重复计数） | 约 203 ms | — |

checkpoint 是 Windows 上 spawn git 的成本；相对 2–3 秒模型调用约 8–12%。  
原始数据：[checkpoint-outbox-overhead.json](checkpoint-outbox-overhead.json)、[recovery.json](recovery.json)

## 8. Outbox 开销

| 操作 | 中位数 | p95 |
|---|---:|---:|
| enqueue 一条节点 outcome | 0.054 ms | 0.114 ms |
| 读取 20 条 pending | 0.240 ms | 0.336 ms |
| mark sent | 0.044 ms | 0.085 ms |

可忽略。原始数据：[checkpoint-outbox-overhead.json](checkpoint-outbox-overhead.json)

## 9. Provider / 协议矩阵

3 次短请求：

| 协议 | 模型 | 成功 | 中位延迟 |
|---|---|---:|---:|
| Anthropic-compatible | deepseek-flash | 3/3 | 738 ms |
| OpenAI-compatible | deepseek-flash | 3/3 | 769 ms |
| Anthropic-compatible | deepseek-v4-pro | 3/3 | 1,062 ms |
| OpenAI-compatible | deepseek-v4-pro | 3/3 | 861 ms |

这里覆盖了**两个模型、两个协议**，但仍然是同一个 DeepSeek 账号/vendor；没有第二个独立供应商凭证。  
原始数据：[protocols.json](protocols.json)

## 10. Hy-Memory

### lite add/search

| 操作 | 中位数 | 平均 | 范围 | 命中 |
|---|---:|---:|---:|---:|
| add | 167.6 ms | 187.0 ms | 156–270 ms | — |
| search | 71.1 ms | 76.1 ms | 33–124 ms | 5/5 |

### pro + working/coding

真实工具轨迹（Edit tool call）：

| 场景 | add 成功 | add 耗时 | search 耗时 | facts | experiences |
|---|---|---:|---:|---:|---:|
| working | 是 | 18.6 s | 132 ms | 1 | 1 |
| coding | 是 | 17.3 s | 16 ms | 1 | 1 |

- 两个场景都路由到 `scene=productivity`
- 能抽取文件路径和改动事实
- pro 的 add 需要 LLM 抽取，约 17–19 秒；search 仍很快
- 未测试 `chat` 的 pro 自动分类，也未测 `ultra`

原始数据：[hy-latency.json](hy-latency.json)、[hy-scenes.json](hy-scenes.json)

## 11. 测试基线

```text
62 个测试文件 / 524 测试通过
耗时 105.18s
语句 95.26% / 分支 90.16% / 函数 98.58% / 行 97.06%
```

## 12. 主要结论

- 线性工作流越长，session 成本优势越大：3 节点 -62%，6 节点 -78%。
- 输入 token 节省稳定在 65–82%，cache read 随前缀长度增长。
- 延迟不是稳定收益：flash 6 节点 -13%，v4-pro 反而 +14%。
- 语义准确率没有下降；session 的价值主要是跨步骤上下文和成本。
- checkpoint 有可测开销，约 0.12 s/ref；outbox 基本免费。
- fork 保留上下文，但成本和延迟都高于新 session。
- 5 并发可跑满 15/15；此前失败是额度问题。
- Hy lite 很快；pro 的写入因 LLM 抽取约 17–19 秒，适合异步 outbox，不适合阻塞节点。

## 13. 仍未覆盖

- 没有第二个独立供应商
- 没有更大规模（10+ 并发、长时运行）压力测试
- 没有端到端代码正确性测试（测试执行/失败修复）
- Hy `chat` pro / `ultra` 未测
- checkpoint 微基准不等于完整工作流 wall-clock
