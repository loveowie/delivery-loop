import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeRepositoryInspector, PreparedRunFactory } from '../../src/controller/run-factory.js';
import { DeliveryRunManager } from '../../src/runtime/run-manager.js';
import { RunRegistry } from '../../src/runtime/run-registry.js';
import { RuntimeFactory } from '../../src/runtime/runtime-factory.js';
import { createGitFixture } from '../workspace/git-fixture.js';

test('run manager completes a scripted-worker delivery loop against real Git', async () => {
  const fixture = await createGitFixture();
  const registryHome = await mkdtemp(join(tmpdir(), 'delivery-loop-registry-'));
  try {
    const prepared = join(fixture.path, '.delivery', 'prepared', 'draft');
    await mkdir(prepared, { recursive: true });
    await writeFile(join(prepared, 'spec.md'), '# Test delivery\n');
    await writeFile(
      join(prepared, 'task-graph.json'),
      JSON.stringify({
        run_id: 'draft',
        requirements: [{ id: 'REQ-1', description: 'command succeeds', status: 'PENDING' }],
        acceptance: [
          {
            id: 'AC-1',
            requirement_id: 'REQ-1',
            description: 'test command passes',
            verification: {
              type: 'command',
              command: 'node -e "process.exit(0)"',
              expected_exit_code: 0,
            },
            mandatory: true,
            risk: 'low',
          },
        ],
        tasks: [
          {
            id: 'TASK-1',
            type: 'implementation',
            title: 'no code changes required',
            status: 'READY',
            priority: 'normal',
            risk: 'low',
            origin: 'initial_plan',
            depends_on: [],
            requirement_ids: ['REQ-1'],
            acceptance_ids: ['AC-1'],
            scope_paths: ['src'],
            required_outputs: [],
            worker_role: 'implementer',
            capability_profile: 'portable',
            attempt: 0,
            max_attempts: 3,
            verification_commands: ['node -e "process.exit(0)"'],
            review_policy: 'none',
          },
        ],
      }),
    );

    const manager = new DeliveryRunManager({
      pluginRoot: process.cwd(),
      preparedRunFactory: new PreparedRunFactory(new NodeRepositoryInspector()),
      runtimeFactory: new RuntimeFactory({
        pluginRoot: process.cwd(),
        probe: {
          async version(command) {
            return command === 'codex' ? 'codex-cli 0.164.0' : undefined;
          },
        },
        workerAdapter: {
          async run(request: { task_id: string }) {
            return {
              task_id: request.task_id,
              status: 'completed' as const,
              summary: 'no code changes required',
              files_changed: [],
              commands_run: [],
              findings: [],
              remaining_risks: [],
              suggested_tasks: [],
              blockers: [],
            };
          },
        },
      }),
      registry: new RunRegistry(registryHome),
      sleep: async () => {},
    });

    const handle = await manager.start({
      repo_root: fixture.path,
      prepared_directory: prepared,
      run_id: 'run-1',
      config_override: {verification:{execution:{backend:'trusted-host'}}},
    });
    let state = handle.state;
    for (let attempt = 0; attempt < 100 && state.status !== 'COMPLETED'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state = (await handle.store.readRun('run-1')) ?? state;
      if (['BLOCKED', 'CANCELLED'].includes(state.status)) {
        break;
      }
    }

    assert.equal(state.status, 'COMPLETED', state.last_error ?? '');
    assert.equal(state.graph.tasks[0]?.status, 'DONE');
    assert.ok(state.integration_snapshot_id);
    await manager.waitForExecutionExit('run-1');
  } finally {
    await fixture.cleanup();
    await rm(registryHome, { recursive: true, force: true });
  }
});
