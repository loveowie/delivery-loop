import type { TaskGraph, TaskNode } from '../domain/types.js';

export interface SchedulerOptions {
  maxWorkers: number;
}

const ACTIVE_STATUSES = new Set<TaskNode['status']>([
  'RUNNING',
  'VERIFYING',
  'REVIEWING',
  'INTEGRATING',
]);

const PRIORITY_ORDER: Record<TaskNode['priority'], number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
}

function pathsOverlap(left: string, right: string): boolean {
  const a = normalizePath(left);
  const b = normalizePath(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function conflictsWithScope(task: TaskNode, occupied: string[]): boolean {
  return task.scope_paths.some((scope) =>
    occupied.some((candidate) => pathsOverlap(scope, candidate)),
  );
}

export function selectReadyTasks(graph: TaskGraph, options: SchedulerOptions): TaskNode[] {
  if (options.maxWorkers <= 0) {
    return [];
  }

  const byId = new Map(graph.tasks.map((task) => [task.id, task]));
  const active = graph.tasks.filter((task) => ACTIVE_STATUSES.has(task.status));
  const slots = Math.max(0, options.maxWorkers - active.length);
  if (slots === 0) {
    return [];
  }

  const occupied = active.flatMap((task) => task.scope_paths);
  const candidates = graph.tasks
    .filter((task) => task.status === 'READY')
    .filter((task) =>
      task.depends_on.every((dependencyId) => byId.get(dependencyId)?.status === 'DONE'),
    )
    .sort(
      (left, right) =>
        PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority] ||
        left.id.localeCompare(right.id),
    );

  const selected: TaskNode[] = [];
  for (const task of candidates) {
    if (selected.length >= slots) {
      break;
    }
    if (conflictsWithScope(task, occupied)) {
      continue;
    }
    selected.push(task);
    occupied.push(...task.scope_paths);
  }

  return selected;
}

export function dependencyIsSatisfied(graph: TaskGraph, task: TaskNode): boolean {
  const byId = new Map(graph.tasks.map((candidate) => [candidate.id, candidate]));
  return task.depends_on.every((dependencyId) => byId.get(dependencyId)?.status === 'DONE');
}

export function promotePendingTasks(graph: TaskGraph): string[] {
  const promoted: string[] = [];
  for (const task of graph.tasks) {
    if (task.status === 'PENDING' && dependencyIsSatisfied(graph, task)) {
      task.status = 'READY';
      promoted.push(task.id);
    }
  }
  return promoted;
}
