import type { RunStatus, TaskStatus } from '../domain/types.js';

const RUN_TRANSITIONS: Record<RunStatus, ReadonlySet<RunStatus>> = {
  DRAFT: new Set(['SPEC_READY', 'CANCELLED']),
  SPEC_READY: new Set(['DRAFT', 'PLANNING', 'CANCELLED']),
  QUEUED: new Set(['RUNNING', 'CANCELLED']),
  PLANNING: new Set(['QUEUED', 'RUNNING', 'WAITING_HUMAN', 'BLOCKED', 'CANCELLED']),
  RUNNING: new Set(['VERIFYING', 'WAITING_HUMAN', 'PAUSED', 'BLOCKED', 'CANCELLED']),
  VERIFYING: new Set(['RUNNING', 'WAITING_HUMAN', 'BLOCKED', 'COMPLETED', 'CANCELLED']),
  WAITING_HUMAN: new Set(['PLANNING', 'RUNNING', 'VERIFYING', 'BLOCKED', 'CANCELLED']),
  PAUSED: new Set(['RUNNING', 'VERIFYING', 'CANCELLED']),
  BLOCKED: new Set(['QUEUED', 'PLANNING', 'RUNNING', 'WAITING_HUMAN', 'CANCELLED']),
  COMPLETED: new Set(),
  CANCELLED: new Set(),
};

const TASK_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  PENDING: new Set(['READY', 'CANCELLED']),
  READY: new Set(['RUNNING', 'BLOCKED', 'CANCELLED']),
  RUNNING: new Set(['VERIFYING', 'INTERRUPTED', 'BLOCKED', 'CANCELLED']),
  VERIFYING: new Set(['DONE', 'REVIEWING', 'INTEGRATING', 'FIX_REQUIRED', 'INTERRUPTED', 'BLOCKED', 'CANCELLED']),
  REVIEWING: new Set(['INTEGRATING', 'FIX_REQUIRED', 'INTERRUPTED', 'BLOCKED', 'CANCELLED']),
  INTEGRATING: new Set(['DONE', 'FIX_REQUIRED', 'BLOCKED', 'INTERRUPTED', 'CANCELLED']),
  FIX_REQUIRED: new Set(['PENDING', 'CANCELLED']),
  INTERRUPTED: new Set(['READY', 'PENDING', 'BLOCKED', 'CANCELLED']),
  DONE: new Set(['PENDING', 'READY']),
  BLOCKED: new Set(['PENDING', 'READY', 'CANCELLED']),
  CANCELLED: new Set(),
};

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!RUN_TRANSITIONS[from].has(to)) {
    throw new Error(`invalid run transition: ${from} -> ${to}`);
  }
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!TASK_TRANSITIONS[from].has(to)) {
    throw new Error(`invalid task transition: ${from} -> ${to}`);
  }
}

export function allowedRunTransitions(from: RunStatus): RunStatus[] {
  return [...RUN_TRANSITIONS[from]];
}

export function allowedTaskTransitions(from: TaskStatus): TaskStatus[] {
  return [...TASK_TRANSITIONS[from]];
}
