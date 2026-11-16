import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexExecArgs, buildWorkerPrompt, extractTokenUsage } from '../../src/workers/codex-exec-adapter.js';
import type { AgentRequest } from '../../src/domain/types.js';

function request(): AgentRequest {
  return {
    run_id: 'run-1',
    task_id: 'TASK-1',
    role: 'implementer',
    capability_profile: 'portable',
    required_skills: [
      {
        skill_id: 'test-driven-development',
        root: '/plugin/capabilities/vendors/superpowers/test-driven-development',
        entry: 'SKILL.md',
        sha256: 'abc',
        resources: ['writing-good-tests.md'],
      },
    ],
    objective: 'Implement one isolated task',
    workdir: '/tmp/worktree',
    requirement_ids: ['REQ-1'],
    acceptance_ids: ['AC-1'],
    scope_paths: ['src/feature'],
    constraints: ['不得递归创建交付运行或交付Worker'],
    verification_commands: ['npm test'],
    context_files: ['AGENTS.md'],
    timeout_seconds: 60,
  };
}

test('codex worker command prefers workspace write and bounded output', () => {
  const args = buildCodexExecArgs(request(), {
    resultPath: '/tmp/result.json',
    schemaPath: '/plugin/schemas/agent-result.schema.json',
  });

  assert.deepEqual(args.slice(0, 2), ['exec', '--json']);
  assert.ok(args.includes('workspace-write'));
  assert.ok(args.includes('--output-schema'));
  assert.ok(args.includes('--output-last-message'));
  assert.ok(args.includes('-C'));
  assert.ok(args.includes('/tmp/worktree'));
  assert.equal(args.includes('--profile'), false);
});

test('explicit worker profile is forwarded when configured', () => {
  const args = buildCodexExecArgs(request(), {
    resultPath: '/tmp/result.json',
    schemaPath: '/plugin/schemas/agent-result.schema.json',
    profile: 'delivery-reviewer',
  });

  assert.ok(args.includes('--profile'));
  assert.ok(args.includes('delivery-reviewer'));
});

test('reviewer and acceptance workers use a read-only sandbox', () => {
  const reviewer = buildCodexExecArgs(
    { ...request(), role: 'reviewer' },
    {
      resultPath: '/tmp/result.json',
      schemaPath: '/plugin/schemas/agent-result.schema.json',
    },
  );
  const acceptance = buildCodexExecArgs(
    { ...request(), role: 'acceptance' },
    {
      resultPath: '/tmp/result.json',
      schemaPath: '/plugin/schemas/agent-result.schema.json',
    },
  );

  assert.ok(reviewer.includes('read-only'));
  assert.ok(acceptance.includes('read-only'));
});

test('worker prompt embeds skill paths and prohibits recursive orchestration', () => {
  const prompt = buildWorkerPrompt(request());

  assert.match(prompt, /\/plugin\/capabilities\/vendors\/superpowers\/test-driven-development\/SKILL.md/);
  assert.match(prompt, /不得递归创建交付运行/);
  assert.match(prompt, /完成当前任务后停止/);
});

test('worker prompt serializes the frozen structured context when present', () => {
  const contextualRequest = {
    ...request(),
    context: {
      specification: 'Implement the frozen requirement',
      requirements: [],
      acceptance: [],
      decisions: [
        {
          decision_id: 'DEC-1',
          response: 'approved',
          answered_at: '2026-11-03T00:00:00.000Z',
        },
      ],
    },
  } satisfies AgentRequest;

  const prompt = buildWorkerPrompt(contextualRequest);

  assert.match(prompt, /## Frozen Context/);
  assert.match(prompt, /"specification": "Implement the frozen requirement"/);
  assert.match(prompt, /"decision_id": "DEC-1"/);
});

test('token usage uses the largest cumulative total reported by JSONL events', () => {
  const usage = extractTokenUsage([
    '{"type":"event","totals":{"total_tokens":100}}',
    '{"type":"event","totals":{"total_tokens":150}}',
  ].join('\n'));

  assert.equal(usage, 150);
});

test('token usage parses turn completion usage without guessing arbitrary nested fields', () => {
  const usage = extractTokenUsage([
    '{"type":"diagnostic","payload":{"total_tokens":9999}}',
    '{"type":"turn.completed","usage":{"input_tokens":120,"output_tokens":30}}',
  ].join('\n'));

  assert.equal(usage, 150);
});


test('missing and invalid usage events remain unknown rather than measured zero',()=>{
  assert.equal(extractTokenUsage(''),undefined);
  assert.equal(extractTokenUsage('{"type":"turn.completed","usage":{"total_tokens":-5}}'),undefined);
  assert.equal(extractTokenUsage('{"type":"turn.completed","usage":{"input_tokens":1.5,"output_tokens":2}}'),undefined);
});
