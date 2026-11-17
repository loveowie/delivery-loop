import { join } from 'node:path';
import type { AgentRequest } from '../domain/types.js';

/**
 * Build the shared task contract used by every delivery worker backend.
 *
 * The DSH adapter appends its subagent/structured-output instructions; this
 * function only describes the delivery task itself.
 */
export function buildWorkerPrompt(request: AgentRequest): string {
  const skillInstructions = request.required_skills
    .map(
      (skill) =>
        `- ${skill.skill_id}: 读取并遵守 ${join(skill.root, skill.entry)}（SHA-256 ${skill.sha256}）`,
    )
    .join('\n');

  const frozenContext = 'context' in request && request.context !== undefined
    ? ['## Frozen Context', JSON.stringify(request.context, null, 2), '']
    : [];

  return [
    '# Delivery Worker Contract',
    '你是由 Delivery Loop 启动的单一任务 Worker。',
    '只完成当前任务；完成当前任务后停止，不得继续调度其他任务。',
    '不得递归创建交付运行或 Worker，不得调用 subagent/workflow 工具，不得等待用户直接输入；需要人工决策时返回 blockers。',
    '不得执行 git commit、git push、git merge 或部署。',
    'Worker 的 completed 只是提交结果，Controller 会独立验证。',
    '',
    `Role: ${request.role}`,
    `Task: ${request.task_id}`,
    `Objective: ${request.objective}`,
    `Requirements: ${request.requirement_ids.join(', ') || '(none)'}`,
    `Acceptance: ${request.acceptance_ids.join(', ') || '(none)'}`,
    `Allowed paths: ${request.scope_paths.join(', ') || '(none)'}`,
    '',
    '## Required Skills',
    skillInstructions || '- 无外部 Skill；使用内置评审规则和当前任务契约。',
    '',
    ...frozenContext,
    '## Constraints',
    ...request.constraints.map((constraint) => `- ${constraint}`),
    '',
    '## Context files',
    ...request.context_files.map((file) => `- ${file}`),
    '',
    '## Verification commands',
    ...request.verification_commands.map((command) => `- ${command}`),
    '',
    '最终输出必须严格符合 AgentResult JSON Schema。',
  ].join('\n');
}
