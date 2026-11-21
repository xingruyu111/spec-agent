import type { WorkStore } from './work-store.js';

export class SourceRuleService {
  constructor(private readonly store: WorkStore) {}

  sourceRules(projectId: string) {
    return this.store.listSourceRules(projectId);
  }

  sourceRule(projectId: string, groupId: string | null, source: string) {
    return this.store.getSourceRule(projectId, groupId, source);
  }

  upsertSourceRule(input: {
    projectId: string;
    groupId?: string | null;
    source: string;
    actions: string[];
    labels?: string[];
    authors?: string[];
    enabled?: boolean;
  }) {
    return this.store.upsertSourceRule(input);
  }

  deleteSourceRule(id: string, projectId: string) {
    return this.store.deleteSourceRule(id, projectId);
  }

}
