import { join } from 'node:path';
import { DshAgentRuntime } from './dsh/dsh-agent-runtime.js';
import { startServer, type ProjectConfig } from './server.js';

function flag(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const rootFlag = flag('root');
const projectsFile = flag('projects-file', process.env.SPEC_AGENT_PROJECTS_FILE);
const projectsHome = flag('projects-home', process.env.SPEC_AGENT_PROJECTS_HOME);
const root = rootFlag ?? (projectsFile ? undefined : process.cwd())!;
const host = flag('host', process.env.SPEC_AGENT_HOST ?? '127.0.0.1')!;
const port = Number(flag('port', process.env.SPEC_AGENT_PORT ?? '4317'));
const webDist = flag('web', join(process.cwd(), 'apps', 'web', 'dist'));
const model = flag('model', process.env.SPEC_AGENT_MODEL ?? 'claude-sonnet-4-5')!;
const token = flag('token', process.env.SPEC_AGENT_TOKEN);

let projects: ProjectConfig[] | undefined;
if (process.env.SPEC_AGENT_PROJECTS) {
  try {
    const parsed = JSON.parse(process.env.SPEC_AGENT_PROJECTS) as ProjectConfig[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('SPEC_AGENT_PROJECTS 必须是非空数组');
    }
    projects = parsed;
  } catch (error) {
    console.error(
      'SPEC_AGENT_PROJECTS 解析失败：',
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  }
}

const webhook = process.env.SPEC_AGENT_NOTIFY_WEBHOOK_URL;
const feishu = process.env.SPEC_AGENT_NOTIFY_FEISHU_URL;
const smtp = process.env.SPEC_AGENT_NOTIFY_SMTP_URL;
const publicUrl = process.env.SPEC_AGENT_PUBLIC_URL;
const notifications =
  webhook || feishu || smtp
    ? {
        webhookUrl: webhook,
        feishuUrl: feishu,
        smtpUrl: smtp,
        publicUrl,
      }
    : undefined;

const server = await startServer({
  root: projects ? undefined : root,
  projects,
  token,
  port,
  host,
  webDist,
  agentRuntime: new DshAgentRuntime(),
  model,
  cleanupWorktrees: process.env.SPEC_AGENT_CLEAN_WORKTREES === '1',
  maxConcurrentChildren: Number(process.env.SPEC_AGENT_MAX_PARALLEL ?? 4),
  isolateNodes: process.env.SPEC_AGENT_ISOLATE_NODES !== '0',
  projectsFile,
  projectsHome,
  notifications,
  mergeAttempts: Number(process.env.SPEC_AGENT_MERGE_ATTEMPTS ?? 2),
  mergeRetryDelayMs: Number(process.env.SPEC_AGENT_MERGE_RETRY_DELAY_MS ?? 250),
  resolveConflicts: process.env.SPEC_AGENT_RESOLVE_CONFLICTS === '1',
  shutdownTimeoutMs: Number(process.env.SPEC_AGENT_SHUTDOWN_TIMEOUT_MS ?? 10_000),
}).catch((error: unknown) => {
  console.error(
    'Spec Agent server 启动失败：',
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
console.log(`Spec Agent server: ${server.url}`);
console.log(`listen: ${host}:${port}`);
console.log(`root: ${projects ? `${projects.length} 个项目` : root ?? projectsFile}`);
console.log(`projects file: ${projectsFile ?? 'static (read-only)'}`);
console.log(
  `notifications: ${
    [webhook && 'webhook', feishu && 'feishu', smtp && 'email']
      .filter(Boolean)
      .join(', ') || 'off'
  }`,
);
console.log(`web:  ${webDist}`);
console.log(`model: ${model}`);
console.log(`auth: ${token ? 'bearer token' : 'off'}`);
console.log(`cleanup worktrees: ${process.env.SPEC_AGENT_CLEAN_WORKTREES === '1' ? 'on' : 'off'}`);
console.log(`isolate nodes: ${process.env.SPEC_AGENT_ISOLATE_NODES !== '0' ? 'on' : 'off'}`);
console.log(`max parallel: ${process.env.SPEC_AGENT_MAX_PARALLEL ?? 4}`);

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) {
    console.error(`收到 ${signal}，进程正在退出，强制结束`);
    process.exit(1);
  }
  shuttingDown = true;
  console.log(`shutting down (${signal})`);
  const force = setTimeout(() => {
    console.error('shutdown timeout，强制退出');
    process.exit(1);
  }, 15_000);
  try {
    await server.close();
  } catch (error) {
    console.error(
      'shutdown failed:',
      error instanceof Error ? error.message : error,
    );
    clearTimeout(force);
    process.exit(1);
  }
  clearTimeout(force);
  process.exit(0);
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
  console.error('uncaughtException:', error);
  void shutdown('uncaughtException');
});
process.on('unhandledRejection', (error) => {
  console.error('unhandledRejection:', error);
  void shutdown('unhandledRejection');
});
