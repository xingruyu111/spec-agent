export type ProjectConfig = {
  id: string;
  name: string;
  root: string;
  /** 缺省 <root>/repo；可直接指向已有 Git 仓库 */
  repoPath?: string;
};
