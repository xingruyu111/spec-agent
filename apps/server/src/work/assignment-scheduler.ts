import type { WorkService } from './work-service.js';

type SchedulerOptions = {
  work: WorkService;
  autoSchedule?: boolean;
  execute: (assignmentId: string) => unknown;
  hasCapacity: (agentId: string) => boolean;
};

export class AssignmentScheduler {
  constructor(private readonly options: SchedulerOptions) {}

  scheduleProjectReady(projectId: string): string[] {
    if (this.options.autoSchedule === false) return [];
    const queued = this.options.work.queuedAssignments(projectId);
    const started: string[] = [];
    for (const assignment of queued) {
      if (!this.options.hasCapacity(assignment.agentId)) continue;
      const ready = assignment.dependsOn.every(
        (dependencyId) =>
          this.options.work.getAssignment(dependencyId)?.state === 'done',
      );
      if (!ready) continue;
      try {
        this.options.execute(assignment.id);
        started.push(assignment.id);
      } catch (error) {
        console.error(
          `[work-executor] project-schedule ${assignment.id}:`,
          error,
        );
      }
    }
    return started;
  }

  scheduleReady(workItemId: string): string[] {
    if (this.options.autoSchedule === false) return [];
    const assignments = this.options.work.listAssignments(workItemId);
    const byId = new Map(
      assignments.map((assignment) => [assignment.id, assignment]),
    );
    const started: string[] = [];
    for (const assignment of assignments) {
      if (assignment.state !== 'queued') continue;
      const ready = assignment.dependsOn.every(
        (dependencyId) => byId.get(dependencyId)?.state === 'done',
      );
      if (!ready) continue;
      if (!this.options.hasCapacity(assignment.agentId)) continue;
      try {
        this.options.execute(assignment.id);
        started.push(assignment.id);
      } catch (error) {
        console.error(
          `[work-executor] auto-schedule ${assignment.id}:`,
          error,
        );
      }
    }
    return started;
  }
}
