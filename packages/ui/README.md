# @spec-agent/ui

Spec Agent 的本地 UI 层，视觉基线参考 [DSH Web Client primitives](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/client/ui-primitives)（MIT）。不直接依赖 DSH 的 workspace 包，组件与 CSS 均为本仓库实现；来源说明见 [NOTICE.md](NOTICE.md)。

不依赖 Tailwind、shadcn、Ant Design 或任何第三方组件库；只有 React 和 CSS token。

## 使用

```tsx
import {
  Button,
  Dialog,
  Field,
  Input,
  SegmentedControl,
  Select,
  Textarea,
} from '@spec-agent/ui';
import '@spec-agent/ui/styles.css';
```

`styles.css` 已在 `apps/web/src/main.tsx` 中全局引入一次。

## Tokens

核心变量定义在 `src/styles.css`：

| Token | 用途 |
|---|---|
| `--ui-bg` / `--ui-surface` | 页面与浮层底色 |
| `--ui-bg-subtle` / `--ui-bg-muted` | 侧栏、分段控件底色 |
| `--ui-ink` / `--ui-ink-2` / `--ui-ink-3` | 主/次/弱文本 |
| `--ui-line` / `--ui-line-strong` | 细边框 |
| `--ui-primary` | 主按钮（近黑，不使用品牌蓝） |
| `--ui-accent` | 仅链接、焦点与状态强调 |
| `--ui-danger` / `--ui-success` / `--ui-warning` | 状态色 |
| `--ui-radius-*` | 4 / 8 / 12 / 16 / pill |
| `--ui-control-height` | 32px，紧凑控件 26px |

暗色主题通过 `data-ui-theme="dark"` 覆盖同名变量，尚未接入应用级主题切换。

## 组件

- `Button`：`primary | ghost | outline | toolbar | danger`，`md` 36px / `sm` 28px，支持 icon/loading/block
- `IconButton`：带 `aria-label` 的方形图标按钮
- `Input` / `Textarea` / `Select`：32px 输入控件、14px 字号、12px 圆角
- `Field` / `FieldSet`：label、hint、error
- `Dialog`（别名 `Modal`）：portal、Esc 关闭、遮罩点击、移动端底部面板
- `SegmentedControl`：问答/任务等模式切换；ARIA tablist、方向键/Home/End、滑动 indicator
- `Surface`：带 token 边框/圆角的容器
- `Tooltip`：hover/focus、四方向、延迟
- `Menu`：trigger/menuitem、Esc/外点关闭、危险项
- `Badge` / `Tag` / `Spinner` / `EmptyState` / `SectionHeader`
- `cx`：class 合并 helper

## 已迁移

- 首页登录、顶栏供应商、hero 新建项目、首页 composer、空状态按钮
- ChatRail 模式切换、composer 输入/发送、模型选择
- ConversationWorkspace 项目选择、子项目操作、会话/组织小按钮
- AgentEditor / ProviderManager 的 Dialog 外框与内部表单
- TaskPreview 状态、分区标题、审批、计划编辑与关闭按钮
- ProjectPlans 与新建项目 Dialog
- 首页项目卡 Surface 化（`as="article"`）与 Tooltip/Menu 接入

## 未迁移

- 首页项目卡的 Surface 化
- 最终旧 CSS 清理

## 验证

```bash
pnpm --filter @spec-agent/ui typecheck
pnpm exec vitest run tests/unit/ui-primitives.test.ts
```

`tests/unit/ui-primitives.test.ts` 用 `react-dom/server` 覆盖按钮语义、表单控件、分段控件、Badge/EmptyState 渲染。
