import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  join(process.cwd(), 'apps', 'web', 'src', 'App.tsx'),
  'utf8',
);

describe('app shell', () => {
  it('不再包含旧任务页分支和入口', () => {
    expect(source).not.toContain('workspaceMode');
    expect(source).not.toContain('taskViewTitle');
    expect(source).not.toContain('loadDetail');
    expect(source).not.toContain('selectedWorkflowNode');
    expect(source).not.toContain('rightTab');
    expect(source).not.toContain('<ChatRail');
    expect(source).not.toMatch(/<div className="app">/);
  });

  it('工作区固定渲染群聊工作台', () => {
    expect(source).toContain(
      "import { WorkspaceShell } from './components/WorkspaceShell'",
    );
    expect(source).toContain('<WorkspaceShell');
    expect(source).not.toContain("import { ConversationWorkspace } from './ConversationWorkspace'");
  });
});
