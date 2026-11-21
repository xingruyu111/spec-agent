/**
 * git 能力端口。
 *
 * 引擎不直接调 git；测试里可以换成内存实现。
 */

export type GitAuthor = {
  name: string;
  email: string;
};

export type WorktreeRequest = {
  repo: string;
  worktree: string;
  branch: string;
  /** commit-ish；缺省为 repo 的 HEAD */
  base?: string;
};

export type WorktreeHandle = {
  path: string;
  branch: string;
  baseCommit: string;
};

export type CommitRequest = {
  worktree: string;
  message: string;
  /** 允许提交的路径前缀；越界直接拒绝 */
  scope: string[];
  /** 注入成 trailer，例如 Spec-Agent / Spec-Agent-Task */
  trailers: Record<string, string>;
  author: GitAuthor;
  allowEmpty?: boolean;
};

export type CommitResult = {
  commit: string;
  files: number;
  insertions: number;
  deletions: number;
};

export type BlameEntry = {
  commit: string;
  line: number;
  content: string;
  author: string;
  trailers: Record<string, string>;
};

export type ConflictContext = {
  worktree: string;
  branch: string;
  files: string[];
  /** 第几次合并尝试，从 1 开始 */
  attempt: number;
};

/** 返回 true 表示冲突已解决，可以继续提交合并 */
export type ConflictResolver = (context: ConflictContext) => Promise<boolean>;

export type MergeRequest = {
  /** 目标 worktree；合并提交会落在这个分支上 */
  worktree: string;
  /** 源分支，例如 agent/fe/task_xxx */
  branch: string;
  message: string;
  trailers: Record<string, string>;
  author: GitAuthor;
  /** 不提供时冲突直接失败；提供时先尝试自动解决 */
  resolveConflicts?: ConflictResolver;
  /** 第几次合并尝试，从 1 开始 */
  attempt?: number;
};

export type MergeResult = {
  commit: string;
  alreadyUpToDate: boolean;
};

export type CommitInfo = {
  hash: string;
  author: string;
  date: string;
  subject: string;
  /** 提交正文末尾的 trailer，例如 Spec-Agent-Node */
  trailers: Record<string, string>;
};

export type CommitFile = {
  status: string;
  path: string;
};

export type BlameLine = {
  line: number;
  commit: string;
  author: string;
  content: string;
};

export interface GitService {
  /** 初始化一个仓库；已存在 .git 时直接返回 */
  initRepo(dir: string): Promise<void>;
  createWorktree(input: WorktreeRequest): Promise<WorktreeHandle>;
  removeWorktree(input: { repo: string; worktree: string; force?: boolean }): Promise<void>;
  head(dir: string): Promise<string>;
  commit(input: CommitRequest): Promise<CommitResult>;
  /** 打一个只读快照 ref，返回当前 HEAD */
  checkpoint(dir: string, ref: string): Promise<string>;
  resetHard(dir: string, commit: string): Promise<void>;
  /** 清理 worktree 未跟踪文件；checkpoint 回滚时使用 */
  clean?(dir: string): Promise<void>;
  blame(input: {
    dir: string;
    path: string;
    line: number;
    /** 省略时看工作区；提供时看指定分支/提交 */
    ref?: string;
  }): Promise<BlameEntry>;
  merge(input: MergeRequest): Promise<MergeResult>;
  /** 从 ref 往回看提交列表 */
  log(dir: string, ref: string, limit?: number): Promise<CommitInfo[]>;
  /** 单个提交的完整 patch 和改动文件列表（已截断到合理上限） */
  show(dir: string, commit: string): Promise<{ patch: string; files: CommitFile[] }>;
  /** 读取某个 ref 下的文件内容 */
  fileAt(dir: string, ref: string, path: string): Promise<string>;
  /** 二进制/媒体 artifact；不能经过 UTF-8 文本截断 */
  fileBufferAt(dir: string, ref: string, path: string): Promise<Buffer>;
  /** 一次性解析整个文件每行的 blame */
  blameAll(input: { dir: string; path: string; ref: string }): Promise<BlameLine[]>;
}
