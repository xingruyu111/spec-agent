import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from 'react';
import { WorkspaceShell } from './components/WorkspaceShell';
import {
  Button,
  Dialog,
  Input,
  Menu,
  Surface,
  Tag,
} from '@spec-agent/ui';
import {
  ApiError,
  api,
  authHeaders,
  getProject,
  getToken,
  setProject,
  setToken,
  type Agent,
  type Project,
  type ProviderSettings,
  type Stats,
} from './api.js';
import { ProviderManager } from './components/ProviderManager';

type Route = { view: 'projects' } | { view: 'workspace'; projectId: string };

function readRoute(): Route {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const match = /^projects\/([^/]+)$/.exec(hash);
  if (match) {
    return { view: 'workspace', projectId: decodeURIComponent(match[1]!) };
  }
  if (!hash) {
    const requested = new URLSearchParams(window.location.search).get('project');
    if (requested) return { view: 'workspace', projectId: requested };
  }
  return { view: 'projects' };
}

function projectHash(id: string): string {
  return `#/projects/${encodeURIComponent(id)}`;
}

type DroppedFile = { path: string; file: File };
type DroppedFolder = { name: string; files: DroppedFile[] };

type DropEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (
    success: (file: File) => void,
    error?: (error: DOMException) => void,
  ) => void;
  createReader?: () => {
    readEntries: (
      success: (entries: DropEntry[]) => void,
      error?: (error: DOMException) => void,
    ) => void;
  };
};

const SKIPPED_DIRECTORIES = new Set(['.git', '.spec-agent', 'node_modules']);

async function readAllEntries(reader: {
  readEntries: (
    success: (entries: DropEntry[]) => void,
    error?: (error: DOMException) => void,
  ) => void;
}): Promise<DropEntry[]> {
  const entries: DropEntry[] = [];
  for (;;) {
    const batch = await new Promise<DropEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) return entries;
    entries.push(...batch);
  }
}

async function readDropEntry(
  entry: DropEntry,
  prefix: string,
  files: DroppedFile[],
): Promise<void> {
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((resolve, reject) => {
      entry.file!(resolve, reject);
    });
    files.push({ path: prefix ? `${prefix}/${entry.name}` : entry.name, file });
    return;
  }
  if (!entry.isDirectory || !entry.createReader) return;
  if (prefix === '' && SKIPPED_DIRECTORIES.has(entry.name)) return;

  const reader = entry.createReader();
  for (const child of await readAllEntries(reader)) {
    if (SKIPPED_DIRECTORIES.has(child.name)) continue;
    await readDropEntry(child, prefix ? `${prefix}/${child.name}` : child.name, files);
  }
}

async function readDroppedFolder(dataTransfer: DataTransfer): Promise<DroppedFolder | null> {
  const item = Array.from(dataTransfer.items).find((entry) => entry.kind === 'file');
  const entry = item?.webkitGetAsEntry?.() as unknown as DropEntry | null;
  if (entry?.isDirectory) {
    const files: DroppedFile[] = [];
    const reader = entry.createReader?.();
    if (reader) {
      for (const child of await readAllEntries(reader)) {
        if (SKIPPED_DIRECTORIES.has(child.name)) continue;
        await readDropEntry(child, '', files);
      }
    }
    if (files.length > 2000) throw new Error('文件夹里文件太多，最多 2000 个');
    return { name: entry.name, files };
  }

  const files = Array.from(dataTransfer.files);
  const relative = files.filter((file) => file.webkitRelativePath.includes('/'));
  if (relative.length === 0) return null;
  const folderName = relative[0]!.webkitRelativePath.split('/')[0]!;
  return {
    name: folderName,
    files: relative.map((file) => ({
      path: file.webkitRelativePath.split('/').slice(1).join('/'),
      file,
    })),
  };
}

export function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectManageable, setProjectManageable] = useState(false);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [droppedFolder, setDroppedFolder] = useState<DroppedFolder | null>(null);
  const [pickingFolder, setPickingFolder] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);
  const [newProject, setNewProject] = useState({ name: '', root: '' });
  const initialRoute = useRef(readRoute()).current;
  const [view, setView] = useState<'projects' | 'workspace'>(initialRoute.view);
  const [project, setProjectState] = useState(
    initialRoute.view === 'workspace' ? initialRoute.projectId : getProject(),
  );
  const [authRequired, setAuthRequired] = useState(false);
  const [tokenInput, setTokenInput] = useState(getToken());
  const [stats, setStats] = useState<Stats | null>(null);
  const [providerOpen, setProviderOpen] = useState(false);
  const [providerSettings, setProviderSettings] = useState<ProviderSettings | null>(null);
  const handleError = useCallback((cause: unknown) => {
    if (cause instanceof ApiError && cause.status === 401) {
      setAuthRequired(true);
      return;
    }
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const loadProjects = useCallback(async () => {
    const data = await api.projects();
    setProjects(data.projects);
    setProjectManageable(data.manageable);
    return data;
  }, []);

  const loadStats = useCallback(async () => {
    setStats(await api.stats());
  }, []);

  const loadList = useCallback(async () => {
    const org = await api.agents();
    setAgents(org.agents);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await loadProjects();
        if (cancelled) return;
        const preferred =
          initialRoute.view === 'workspace'
            ? initialRoute.projectId
            : getProject();
        const next = data.projects.some((candidate) => candidate.id === preferred)
          ? preferred
          : data.defaultProject;
        setProject(next);
        setProjectState(next);
        if (
          initialRoute.view === 'workspace' &&
          !data.projects.some((candidate) => candidate.id === initialRoute.projectId)
        ) {
          setView('projects');
          window.history.replaceState(null, '', '#/projects');
        }
        setAuthRequired(false);
      } catch (cause) {
        handleError(cause);
      } finally {
        if (!cancelled) setProjectsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadProjects, handleError, initialRoute]);

  useEffect(() => {
    if (window.location.hash) return;
    window.history.replaceState(
      null,
      '',
      view === 'workspace' ? projectHash(project) : '#/projects',
    );
  }, [view, project]);

  useEffect(() => {
    if (authRequired || view !== 'projects') return;
    void loadStats().catch(() => undefined);
  }, [authRequired, view, projects.length, loadStats]);

  useEffect(() => {
    const sync = (): void => {
      const route = readRoute();
      if (route.view === 'projects') {
        setView('projects');
        return;
      }
      setView('workspace');
      setProject(route.projectId);
      setProjectState(route.projectId);
      if (route.projectId !== project) {
      }
    };
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
    };
  }, [project]);

  useEffect(() => {
    if (authRequired || view !== 'workspace') return;
    void loadList().catch(handleError);
    // SSE 断线时的兜底轮询，不再依赖 2 秒高频轮询
    const timer = setInterval(() => {
      void loadList().catch(handleError);
    }, 10_000);
    return () => clearInterval(timer);
  }, [authRequired, view, project, loadList, handleError]);

  useEffect(() => {
    if (authRequired || view !== 'workspace') return;

    const controller = new AbortController();
    let buffer = '';
    let timer: ReturnType<typeof setTimeout> | undefined;

    const refresh = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void loadList().catch(handleError);
      }, 250);
    };

    void (async () => {
      try {
        const response = await fetch('/api/events/stream', {
          headers: authHeaders(),
          signal: controller.signal,
        });
        if (response.status === 401) {
          setAuthRequired(true);
          return;
        }
        if (!response.ok || !response.body) return;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split('\n\n');
          buffer = chunks.pop() ?? '';
          for (const chunk of chunks) {
            if (chunk.startsWith('data:')) refresh();
          }
        }
      } catch {
        // 断开后由 10 秒兜底轮询继续刷新
      }
    })();

    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [authRequired, view, project, loadList, handleError]);

  const login = async (event: FormEvent) => {
    event.preventDefault();
    const value = tokenInput.trim();
    if (!value) return;

    setToken(value);
    setError(null);
    try {
      const data = await loadProjects();
      const preferred = view === 'workspace' ? project : getProject();
      const next = data.projects.some((candidate) => candidate.id === preferred)
        ? preferred
        : data.defaultProject;
      setProject(next);
      setProjectState(next);
      if (view === 'workspace') await loadList();
      setAuthRequired(false);
    } catch (cause) {
      setToken('');
      handleError(cause);
    }
  };

  const changeProject = (id: string) => {
    setProject(id);
    setProjectState(id);
  };

  const enterProject = (id: string): void => {
    changeProject(id);
    setView('workspace');
    setError(null);
    window.history.pushState(null, '', projectHash(id));
  };

  const goProjects = (): void => {
    setView('projects');
    setError(null);
    window.history.pushState(null, '', '#/projects');
  };

  const openNewProject = (): void => {
    setNewProject({ name: '', root: '' });
    setDroppedFolder(null);
    setError(null);
    setNewProjectOpen(true);
  };

  const pickProjectFolder = async (): Promise<void> => {
    setPickingFolder(true);
    setError(null);
    try {
      const path = await api.pickFolder();
      if (path) {
        setNewProject((current) => ({ ...current, root: path }));
        setDroppedFolder(null);
      }
    } catch (cause) {
      handleError(cause);
    } finally {
      setPickingFolder(false);
    }
  };

  const acceptDroppedFolder = async (
    event: DragEvent<HTMLElement>,
    openModal: boolean,
  ): Promise<void> => {
    event.preventDefault();
    setDragActive(false);
    setError(null);
    try {
      const folder = await readDroppedFolder(event.dataTransfer);
      if (!folder) {
        setError('请拖入一个文件夹，而不是单个文件');
        return;
      }
      setDroppedFolder(folder);
      setNewProject((current) => ({
        ...current,
        name: current.name.trim() || folder.name,
        root: '',
      }));
      if (openModal) setNewProjectOpen(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const createProject = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!newProject.name.trim()) return;

    setProjectBusy(true);
    setError(null);
    try {
      const created = droppedFolder
        ? await api.importProject(newProject.name.trim(), droppedFolder.files)
        : await api.createProject(
            newProject.name.trim(),
            newProject.root.trim() || undefined,
          );
      await loadProjects();
      await loadStats().catch(() => undefined);
      setNewProject({ name: '', root: '' });
      setDroppedFolder(null);
      setNewProjectOpen(false);
      enterProject(created.id);
    } catch (cause) {
      handleError(cause);
    } finally {
      setProjectBusy(false);
    }
  };

  const archiveProject = async (target: Project): Promise<void> => {
    if (
      !window.confirm(
        `归档组织「${target.name}」？组织目录和数据会保留，只是从列表移除。`,
      )
    ) {
      return;
    }

    setProjectBusy(true);
    setError(null);
    try {
      await api.archiveProject(target.id);
      const data = await loadProjects();
      await loadStats().catch(() => undefined);
      if (target.id === project) {
        const next = data.defaultProject;
        setProject(next);
        setProjectState(next);
      }
    } catch (cause) {
      handleError(cause);
    } finally {
      setProjectBusy(false);
    }
  };

  const openProvider = async (): Promise<void> => {
    setProviderOpen(true);
    try {
      setProviderSettings(await api.provider(true));
    } catch (cause) {
      handleError(cause);
    }
  };

  const providerModal = (
    <ProviderManager
      open={providerOpen}
      settings={providerSettings}
      onClose={() => setProviderOpen(false)}
      onSaved={(settings) => {
        setProviderSettings(settings);
      }}
    />
  );

  const currentProject = projects.find((candidate) => candidate.id === project);

  if (authRequired) {
    return (
      <div className="login-screen">
        <form className="login-card" onSubmit={(event) => void login(event)}>
          <div className="logo">⬡</div>
          <h1>连接 Spec Agent</h1>
          <p className="muted">服务器开启了 Bearer token 校验。</p>
          <Input
            type="password"
            autoFocus
            placeholder="SPEC_AGENT_TOKEN"
            value={tokenInput}
            onChange={(event) => setTokenInput(event.target.value)}
          />
          <Button
            type="submit"
            variant="primary"
            block
            disabled={!tokenInput.trim()}
          >
            连接
          </Button>
          {error ? <div className="error">{error}</div> : null}
        </form>
      </div>
    );
  }

  if (view === 'projects') {    return (
      <div className="app home-shell">
        <header className="topbar home-topbar">
          <div className="brand">
            <span className="logo">⬡</span>
            <span>Spec Agent</span>
            <span className="sub">组织工作区</span>
          </div>
          <div className="top-meta">
            <Button variant="ghost" size="sm" onClick={() => void openProvider()}>
              供应商
            </Button>
            <span className="muted">{projects.length} 个组织</span>
          </div>
        </header>

        <main
          className="project-home"
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(event) => void acceptDroppedFolder(event, true)}
        >
          {dragActive && !newProjectOpen ? (
            <div className="home-drop-overlay">
              <div className="home-drop-mark">↓</div>
              <strong>松开以导入文件夹</strong>
              <span>会复制文件到新的组织目录</span>
            </div>
          ) : null}
          <div className="home-org-head">
            <div>
              <span className="home-org-kicker">组织</span>
              <h1>组织管理</h1>
              <p>管理 Agent 组织；进入组织后创建和管理独立项目。</p>
            </div>
            {projectManageable && projects.length > 0 ? (
              <Button
                variant="primary"
                disabled={projectBusy}
                onClick={openNewProject}
              >
                新建组织
              </Button>
            ) : null}
          </div>

          {error ? <div className="home-error">{error}</div> : null}

          {projectsLoading ? (
            <div className="home-loading">正在加载组织…</div>
          ) : projects.length === 0 ? (
            <div className="home-empty">
              <div className="home-empty-mark">◳</div>
              <h2>还没有组织</h2>
              <p>创建一个组织，Spec Agent 会为它初始化仓库、数据库和 Agent 配置。</p>
              {projectManageable ? (
                <Button variant="primary" onClick={openNewProject}>
                  新建第一个组织
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="project-grid">
              {projects.map((candidate) => {
                const metric = stats?.projects.find(
                  (entry) => entry.id === candidate.id,
                );
                return (
                  <Surface
                    as="article"
                    className="project-card"
                    padding="none"
                    key={candidate.id}
                  >
                    <Button variant="plain"
                      className="project-open"
                      onClick={() => enterProject(candidate.id)}
                      title={`打开 ${candidate.name}`}
                    >
                      <div className="project-card-head">
                        <span className="project-mark">
                          {candidate.name.slice(0, 1).toUpperCase()}
                        </span>
                        <span className="project-card-copy">
                          <span className="project-name">{candidate.name}</span>
                          <code className="project-id">{candidate.id}</code>
                        </span>
                        <Tag className="project-open-hint">打开</Tag>
                      </div>
                      <span className="project-path" title={candidate.root}>
                        {candidate.root}
                      </span>
                      <span className="project-stats">
                        <span>
                          <b>{metric?.workflowCount ?? '—'}</b>
                          <small>工作流</small>
                        </span>
                        <span>
                          <b>{metric?.pendingGates ?? '—'}</b>
                          <small>待审批</small>
                        </span>
                        <span>
                          <b>
                            {metric
                              ? `${Math.round(metric.failureRate * 100)}%`
                              : '—'}
                          </b>
                          <small>失败率</small>
                        </span>
                      </span>
                    </Button>
                    <div className="project-card-foot">
                      <span className="project-cost">
                        {metric ? `$${metric.totalCostUsd.toFixed(2)}` : '—'}
                      </span>
                      {projectManageable && projects.length > 1 ? (
                        <Menu
                          label={`${candidate.name} 操作`}
                          trigger={<span aria-hidden="true">⋯</span>}
                          items={[
                            {
                              label: '归档组织',
                              danger: true,
                              disabled: projectBusy,
                              onSelect: () => void archiveProject(candidate),
                            },
                          ]}
                        />
                      ) : null}
                    </div>
                  </Surface>
                );
              })}
            </div>
          )}

          <div className="home-footnote">
            {projectManageable
              ? '归档只会从列表移除，不会删除组织目录、git 历史或任务数据。'
              : '组织由 SPEC_AGENT_PROJECTS 静态配置；设置 SPEC_AGENT_PROJECTS_FILE 后可以在这里创建和归档。'}
          </div>
        </main>

        <Dialog
          open={newProjectOpen}
          onClose={() => setNewProjectOpen(false)}
          title="新建组织"
          description="会初始化独立 git 仓库和 .spec-agent 数据库"
          width={560}
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => setNewProjectOpen(false)}
              >
                取消
              </Button>
              <Button
                variant="primary"
                type="submit"
                form="create-project-form"
                disabled={projectBusy || !newProject.name.trim()}
                loading={projectBusy}
              >
                {projectBusy ? '创建中…' : '创建组织'}
              </Button>
            </>
          }
        >
          <form
            id="create-project-form"
            className="create-project-form"
            onSubmit={(event) => void createProject(event)}
          >
            <label>
              组织名
              <Input
                autoFocus
                placeholder="例如 登录页重构"
                value={newProject.name}
                onChange={(event) =>
                  setNewProject((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
              />
            </label>
            <div className="create-field">
              <span className="create-field-label">组织目录</span>
              <div className="directory-picker">
                <span className="directory-path" title={newProject.root || undefined}>
                  {droppedFolder
                    ? `将导入：${droppedFolder.name}（${droppedFolder.files.length} 个文件）`
                    : newProject.root || '未选择，将自动创建'}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pickingFolder || projectBusy}
                  onClick={() => void pickProjectFolder()}
                >
                  {pickingFolder ? '选择中…' : '选择本机文件夹'}
                </Button>
              </div>
              {droppedFolder ? (
                <div className="drop-summary">
                  已拖入 <b>{droppedFolder.name}</b>，{droppedFolder.files.length} 个文件
                  <Button
                    variant="ghost"
                    size="sm"
                    className="link-button"
                    onClick={() => setDroppedFolder(null)}
                  >
                    移除
                  </Button>
                </div>
              ) : null}
              <div
                className={`folder-drop ${dragActive ? 'active' : ''}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragActive(true);
                }}
                onDragLeave={() => setDragActive(false)}
                onDrop={(event) => void acceptDroppedFolder(event, false)}
              >
                <span className="folder-drop-mark">↓</span>
                <span>
                  <b>或把文件夹拖到这里</b>
                  <small>
                    会复制文件到新组织目录；.git / .spec-agent / node_modules 会跳过
                  </small>
                </span>
              </div>
            </div>
            <p className="create-project-hint">
              选择空目录或已有 Spec Agent 组织目录直接创建；拖入文件夹会创建一个导入副本。
            </p>
          </form>
        </Dialog>
        {providerModal}
      </div>
    );
  }

  return (
      <>
        <WorkspaceShell
          key={project}
          projectId={project}
          projectName={currentProject?.name ?? project}
          agents={agents}
          onBackToProjects={goProjects}
          onError={handleError}
        />
        {providerModal}
      </>
    );
}












