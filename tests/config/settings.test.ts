import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeLimitsSchema, SettingsStore } from '../../src/config/settings.js';

async function tempRepos(): Promise<{ repo: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), 'delivery-loop-settings-'));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  await mkdir(repo, { recursive: true });
  return { repo, home };
}

test('settings default to the built-in runtime budgets when no file exists', async () => {
  const { repo, home } = await tempRepos();
  const store = new SettingsStore({ home });
  const view = await store.describe(repo);

  assert.equal(view.global.exists, false);
  assert.equal(view.repo.exists, false);
  assert.equal(view.effective.max_total_tokens, 2_000_000);
  assert.equal(view.effective.max_duration_hours, 8);
  assert.equal(view.effective.max_task_attempts, 3);
  assert.equal(view.effective.no_progress_cycles, 3);
});

test('repository settings override global settings field by field', async () => {
  const { repo, home } = await tempRepos();
  const store = new SettingsStore({ home });
  await store.writeGlobal({ max_total_tokens: 4_000_000, max_duration_hours: 10 });
  await store.writeRepo(repo, { max_total_tokens: 8_000_000 });

  assert.deepEqual(await store.readGlobal(), { max_total_tokens: 4_000_000, max_duration_hours: 10 });
  assert.deepEqual(await store.mergedRuntime(repo), { max_total_tokens: 8_000_000, max_duration_hours: 10 });
  const view = await store.describe(repo);
  assert.equal(view.effective.max_total_tokens, 8_000_000);
  assert.equal(view.effective.max_duration_hours, 10);
  assert.equal(view.effective.max_task_attempts, 3);
  assert.match(
    await readFile(join(repo, '.delivery', 'settings.yaml'), 'utf8'),
    /max_total_tokens: 8000000/,
  );
});

test('settings override the runtime block in delivery.yaml', async () => {
  const { repo, home } = await tempRepos();
  await writeFile(
    join(repo, 'delivery.yaml'),
    ['runtime:', '  max_total_tokens: 1000000', '  max_parallel_workers: 4'].join('\n'),
  );
  const store = new SettingsStore({ home });
  await store.writeGlobal({ max_duration_hours: 2 });

  const view = await store.describe(repo);
  assert.equal(view.delivery_yaml.runtime.max_total_tokens, 1_000_000);
  assert.equal(view.effective.max_total_tokens, 1_000_000);
  assert.equal(view.effective.max_parallel_workers, 4);
  assert.equal(view.effective.max_duration_hours, 2);
});

test('an empty save clears the scope and removes its file', async () => {
  const { repo, home } = await tempRepos();
  const store = new SettingsStore({ home });
  await store.writeRepo(repo, { max_task_attempts: 5 });
  assert.equal((await store.describe(repo)).repo.exists, true);

  await store.reset('repo', repo);
  const view = await store.describe(repo);
  assert.equal(view.repo.exists, false);
  assert.deepEqual(view.repo.runtime, {});
});

test('only whitelisted positive runtime limits are accepted', () => {
  assert.equal(RuntimeLimitsSchema.safeParse({ max_total_tokens: 10 }).success, true);
  assert.equal(RuntimeLimitsSchema.safeParse({ max_total_tokens: 0 }).success, false);
  assert.equal(RuntimeLimitsSchema.safeParse({ max_total_tokens: 1.5 }).success, false);
  assert.equal(RuntimeLimitsSchema.safeParse({ max_duration_hours: 0 }).success, false);
  assert.equal(RuntimeLimitsSchema.safeParse({ max_task_attempts: 0 }).success, false);
  // Non-budget configuration cannot be changed through the settings panel.
  assert.equal(RuntimeLimitsSchema.safeParse({ git: { mode: 'merge' } }).success, false);
  assert.equal(RuntimeLimitsSchema.safeParse({ verification: {} }).success, false);
  assert.equal(RuntimeLimitsSchema.safeParse({ unknown_budget: 1 }).success, false);
});

test('a malformed settings file is reported instead of silently ignored', async () => {
  const { repo, home } = await tempRepos();
  const store = new SettingsStore({ home });
  await mkdir(join(repo, '.delivery'), { recursive: true });
  await writeFile(join(repo, '.delivery', 'settings.yaml'), 'runtime:\n  max_total_tokens: -1\n');

  await assert.rejects(store.readRepo(repo), /invalid settings file/);
  await writeFile(join(repo, '.delivery', 'settings.yaml'), 'runtime:\n  git_mode: merge\n');
  await assert.rejects(store.readRepo(repo), /invalid settings file/);
});
