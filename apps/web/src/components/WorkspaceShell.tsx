import { useEffect, useState } from 'react';
import {
  api,
  setProject as setActiveProject,
  type Agent,
  type ChatProject,
  type WorkGroup,
} from '../api.js';
import { GroupPanel } from './GroupPanel';
import { PrivateChat } from './PrivateChat';

type WorkspaceShellProps = {
  projectId: string;
  projectName: string;
  agents: Agent[];
  onBackToProjects: () => void;
  onError: (message: string) => void;
};

type GroupSelection = {
  projectId: string;
  groupId: string;
  groupName: string;
};

function FolderIcon() {
  return (
    <svg className="tree-folder-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M1.5 4.2c0-.6.5-1.1 1.1-1.1h3.1l1.2 1.3h5.5c.6 0 1.1.5 1.1 1.1v6.3c0 .6-.5 1.1-1.1 1.1H2.6c-.6 0-1.1-.5-1.1-1.1V4.2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
      />
    </svg>
  );
}

/**
 * 单一工作区：左侧项目/群聊树，右侧群聊内容。
 * 项目与群聊放在同一层树里，不再有独立项目页。
 */
export function WorkspaceShell({
  projectId,
  projectName,
  agents,
  onBackToProjects,
  onError,
}: WorkspaceShellProps) {
  const [projects, setProjects] = useState<ChatProject[]>([]);
  const [groups, setGroups] = useState<Record<string, WorkGroup[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<GroupSelection | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [localAgents, setLocalAgents] = useState<Agent[]>(agents);
  const [addingAgent, setAddingAgent] = useState(false);
  const [newAgentName, setNewAgentName] = useState('');
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [newProject, setNewProject] = useState('');
  const [addingProject, setAddingProject] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [groupFormFor, setGroupFormFor] = useState<string | null>(null);
  const [newGroup, setNewGroup] = useState('');
  const [creatingGroup, setCreatingGroup] = useState(false);

  const loadGroups = async (list: ChatProject[]): Promise<void> => {
    const entries = await Promise.all(
      list.map(async (project) => {
        const result = await api.workGroups(project.id);
        return [project.id, result.groups] as const;
      }),
    );
    setGroups(Object.fromEntries(entries));
  };

  useEffect(() => {
    setLocalAgents(agents);
  }, [agents]);

  useEffect(() => {
    const timer = setInterval(() => {
      void api
        .agents()
        .then((result) => setLocalAgents(result.agents))
        .catch(() => undefined);
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setActiveProject(projectId);
    setLoading(true);
    void api
      .chatProjects()
      .then(async (result) => {
        if (cancelled) return;
        setProjects(result.projects);
        setExpanded(
          result.projects.length > 0
            ? { [result.projects[0]!.id]: true }
            : {},
        );
        await loadGroups(result.projects);
      })
      .catch((error: Error) => onError(error.message))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onError, projectId]);

  useEffect(() => {
    if (projects.length === 0) return;
    const timer = setInterval(() => {
      void loadGroups(projects).catch(() => undefined);
    }, 10_000);
    return () => clearInterval(timer);
  }, [projects]);

  const createAgent = async (): Promise<void> => {
    const name = newAgentName.trim();
    if (!name) return;
    setCreatingAgent(true);
    try {
      const config = await api.agentConfig();
      const id = `agent-${Date.now().toString(36)}`;
      await api.saveAgentConfig([
        ...config.agents,
        {
          id,
          name,
          parent: null,
          role: '项目 Agent',
          systemPrompt: '你是这个组织的项目 Agent，负责回答问题和协助推进任务。',
          model: { provider: 'inherit', model: 'inherit' },
          skills: [],
          nodes: [],
          tools: { allow: ['Read'], shell: 'readonly' },
          canDelegateTo: [],
          workspace: { writeScope: ['.'] },
        },
      ]);
      const updated = await api.agents();
      setLocalAgents(updated.agents);
      setNewAgentName('');
      setAddingAgent(false);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreatingAgent(false);
    }
  };

  const createProject = async (): Promise<void> => {
    const name = newProject.trim();
    if (!name) return;
    setCreatingProject(true);
    try {
      const created = await api.createChatProject(name);
      setProjects((current) => [created, ...current]);
      setExpanded((current) => ({ ...current, [created.id]: true }));
      setGroups((current) => ({ ...current, [created.id]: [] }));
      setNewProject('');
      setAddingProject(false);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreatingProject(false);
    }
  };

  const createGroup = async (target: ChatProject): Promise<void> => {
    const name = newGroup.trim();
    if (!name) return;
    setCreatingGroup(true);
    try {
      const created = await api.createWorkGroup(target.id, name);
      setGroups((current) => ({
        ...current,
        [target.id]: [...(current[target.id] ?? []), created],
      }));
      setExpanded((current) => ({ ...current, [target.id]: true }));
      setNewGroup('');
      setGroupFormFor(null);
      setSelected({
        projectId: target.id,
        groupId: created.id,
        groupName: created.name,
      });
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreatingGroup(false);
    }
  };

  const selectedProject = projects.find(
    (project) => project.id === selected?.projectId,
  );
  const privateProject =
    selectedProject ?? projects[0] ?? null;
  const privateGroups = privateProject
    ? groups[privateProject.id] ?? []
    : [];

  return (
    <div className="workspace-shell">
      <header className="workspace-top">
        <button type="button" onClick={onBackToProjects}>
          ← 工作台
        </button>
        <div>
          <b>{projectName}</b>
          <small>工作区</small>
        </div>
      </header>

      <div className="workspace-body">
        <aside className="workspace-tree">
          <div className="workspace-tree-head">
            <span>组织</span>
            <button
              type="button"
              title="新建 Agent"
              onClick={() => setAddingAgent((current) => !current)}
            >
              +
            </button>
          </div>
          {addingAgent ? (
            <form
              className="workspace-tree-form"
              onSubmit={(event) => {
                event.preventDefault();
                void createAgent();
              }}
            >
              <input
                autoFocus
                value={newAgentName}
                placeholder="Agent 名称"
                onChange={(event) => setNewAgentName(event.target.value)}
              />
              <button
                type="submit"
                disabled={creatingAgent || !newAgentName.trim()}
              >
                创建
              </button>
            </form>
          ) : null}
          <div className="workspace-agent-list">
            {localAgents.map((agent) => (
              <button
                type="button"
                key={agent.id}
                className={`workspace-agent-row ${
                  selectedAgent?.id === agent.id ? 'active' : ''
                }`}
                onClick={() => {
                  setSelectedAgent(agent);
                  setSelected(null);
                }}
              >
                <span className="workspace-agent-avatar">
                  {agent.name.slice(0, 1)}
                </span>
                <span className="workspace-agent-copy">
                  <b>{agent.name}</b>
                </span>
              </button>
            ))}
            {localAgents.length === 0 ? (
              <p className="workspace-tree-empty">还没有 Agent</p>
            ) : null}
          </div>

          <div className="workspace-tree-head">
            <span>工作区</span>
            <div>
              <button
                type="button"
                title="新建项目"
                onClick={() => setAddingProject((current) => !current)}
              >
                +
              </button>
            </div>
          </div>

          {addingProject ? (
            <form
              className="workspace-tree-form"
              onSubmit={(event) => {
                event.preventDefault();
                void createProject();
              }}
            >
              <input
                autoFocus
                value={newProject}
                placeholder="项目名称"
                onChange={(event) => setNewProject(event.target.value)}
              />
              <button
                type="submit"
                disabled={creatingProject || !newProject.trim()}
              >
                创建
              </button>
            </form>
          ) : null}

          {loading ? (
            <p className="workspace-tree-empty">正在加载…</p>
          ) : null}

          <div className="workspace-tree-list">
            {projects.map((project) => {
              const projectGroups = groups[project.id] ?? [];
              const isExpanded = expanded[project.id] ?? false;
              return (
                <div className="workspace-tree-project" key={project.id}>
                  <div
                    className={`workspace-tree-row ${
                      selected?.projectId === project.id ? 'selected' : ''
                    }`}
                  >
                    <button
                      type="button"
                      className="workspace-tree-toggle"
                      onClick={() =>
                        setExpanded((current) => ({
                          ...current,
                          [project.id]: !isExpanded,
                        }))
                      }
                    >
                      <span className="workspace-tree-caret">
                        {isExpanded ? '▾' : '▸'}
                      </span>
                      <FolderIcon />
                      <span className="workspace-tree-name">
                        {project.name}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="workspace-tree-add"
                      title="新建群聊"
                      onClick={() => {
                        setGroupFormFor((current) =>
                          current === project.id ? null : project.id,
                        );
                        setExpanded((current) => ({
                          ...current,
                          [project.id]: true,
                        }));
                      }}
                    >
                      +
                    </button>
                  </div>

                  {isExpanded ? (
                    <div className="workspace-tree-groups">
                      {projectGroups.map((group) => (
                        <button
                          type="button"
                          key={group.id}
                          className={`workspace-tree-group ${
                            selected?.groupId === group.id ? 'active' : ''
                          }`}
                          onClick={() =>
                            {
                              setSelectedAgent(null);
                              setSelected({
                                projectId: project.id,
                                groupId: group.id,
                                groupName: group.name,
                              });
                            }
                          }
                        >
                          {group.name}
                        </button>
                      ))}
                      {groupFormFor === project.id ? (
                        <form
                          className="workspace-tree-form workspace-tree-form--group"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void createGroup(project);
                          }}
                        >
                          <input
                            autoFocus
                            value={newGroup}
                            placeholder="#群聊"
                            onChange={(event) =>
                              setNewGroup(event.target.value)
                            }
                          />
                          <button
                            type="submit"
                            disabled={creatingGroup || !newGroup.trim()}
                          >
                            创建
                          </button>
                        </form>
                      ) : null}
                      {projectGroups.length === 0 &&
                      groupFormFor !== project.id ? (
                        <p className="workspace-tree-no-group">
                          还没有群聊，点 +
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {!loading && projects.length === 0 ? (
              <p className="workspace-tree-empty">
                还没有项目，点右上角 + 新建。
              </p>
            ) : null}
          </div>
        </aside>

        <main className="workspace-main">
          {selectedAgent && privateProject ? (
            <PrivateChat
              key={selectedAgent.id}
              projectId={privateProject.id}
              agents={localAgents}
              groups={privateGroups}
              initialAgentId={selectedAgent.id}
              embedded
              onClose={() => setSelectedAgent(null)}
              onError={onError}
            />
          ) : selected && selectedProject ? (
            <GroupPanel
              key={selected.groupId}
              projectId={selected.projectId}
              groupId={selected.groupId}
              agents={localAgents}
              onError={onError}
            />
          ) : (
            <div className="workspace-welcome">
              <h2>{projectName}</h2>
              <p>
                点左边 Agent 私聊，或选择项目下的群聊；项目旁 + 可新建群聊。
              </p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

