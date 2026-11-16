import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillResolver } from '../../src/capabilities/skill-resolver.js';

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'delivery-loop-skills-'));
  const generic = join(root, 'capabilities', 'vendors', 'generic');
  const openspec = join(root, 'capabilities', 'vendors', 'openspec');
  await mkdir(generic, { recursive: true });
  await mkdir(openspec, { recursive: true });
  await writeFile(join(generic, 'SKILL.md'), '# Generic\nUse TDD.\n');
  await writeFile(join(openspec, 'SKILL.md'), '# OpenSpec\nUse OpenSpec.\n');
  const genericHash = createHash('sha256').update('# Generic\nUse TDD.\n').digest('hex');
  const openspecHash = createHash('sha256').update('# OpenSpec\nUse OpenSpec.\n').digest('hex');

  await mkdir(join(root, 'capabilities'), { recursive: true });
  await writeFile(
    join(root, 'capabilities', 'profiles.yaml'),
    [
      'profiles:',
      '  portable:',
      '    skills: [generic]',
      '  openspec:',
      '    extends: portable',
      '    requires: [openspec-cli]',
    ].join('\n'),
  );
  await writeFile(
    join(root, 'capabilities', 'role-skills.yaml'),
    [
      'roles:',
      '  implementer:',
      '    skills: [generic]',
      '    profile_skills:',
      '      openspec: [openspec]',
      '  acceptance:',
      '    skills: [generic]',
    ].join('\n'),
  );
  await writeFile(
    join(root, 'capabilities', 'skills.lock.yaml'),
    [
      'version: 1',
      'skills:',
      '  generic:',
      '    path: capabilities/vendors/generic',
      '    entry: SKILL.md',
      '    sha256: ' + genericHash,
      '    resources: []',
      '  openspec:',
      '    path: capabilities/vendors/openspec',
      '    entry: SKILL.md',
      '    sha256: ' + openspecHash,
      '    resources: []',
    ].join('\n'),
  );
  return root;
}

test('portable profile does not resolve OpenSpec skills', async () => {
  const root = await fixtureRoot();
  const resolver = await SkillResolver.open(root);

  const skills = await resolver.resolve('portable', 'implementer', []);

  assert.deepEqual(skills.map((skill) => skill.skill_id), ['generic']);
});

test('openspec profile adds its OpenSpec capability', async () => {
  const root = await fixtureRoot();
  const resolver = await SkillResolver.open(root);

  const skills = await resolver.resolve('openspec', 'implementer', []);

  assert.deepEqual(skills.map((skill) => skill.skill_id), ['generic', 'openspec']);
  assert.deepEqual(resolver.requiredExternalCapabilities('openspec'), ['openspec-cli']);
});

test('rejects hash mismatch before a worker starts', async () => {
  const root = await fixtureRoot();
  const resolver = await SkillResolver.open(root);
  const [skill] = await resolver.resolve('portable', 'implementer', []);
  assert.ok(skill);

  await assert.rejects(
    resolver.verify({ ...skill, sha256: 'bad' }),
    /hash/i,
  );
});

test('project Skills resolve relative to the target repository and reject escapes', async () => {
  const root = await fixtureRoot();
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-project-skill-'));
  await mkdir(join(repo, '.delivery', 'skills', 'project-skill'), { recursive: true });
  await writeFile(join(repo, '.delivery', 'skills', 'project-skill', 'SKILL.md'), '# Project\n');
  const resolver = await SkillResolver.open(root);

  const skills = await resolver.resolve(
    'portable',
    'implementer',
    ['.delivery/skills/project-skill'],
    repo,
  );
  assert.ok(skills.some((skill) => /^project-project-skill-[a-f0-9]{12}$/.test(skill.skill_id)));
  await assert.rejects(
    resolver.resolve('portable', 'implementer', ['../outside'], repo),
    /project root/i,
  );

  const outside = await mkdtemp(join(tmpdir(), 'delivery-loop-outside-skill-'));
  await mkdir(join(outside, 'nested'), { recursive: true });
  await writeFile(join(outside, 'nested', 'SKILL.md'), '# Outside\n');
  await symlink(outside, join(repo, 'linked-parent'));
  await assert.rejects(
    resolver.resolve('portable', 'implementer', ['linked-parent/nested'], repo),
    /project root|symlink.*outside/i,
  );
});

test('project Skills with the same basename get distinct stable path-derived ids', async () => {
  const root = await fixtureRoot();
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-project-skill-'));
  for (const directory of ['team-a/review', 'team-b/review']) {
    await mkdir(join(repo, directory), { recursive: true });
    await writeFile(join(repo, directory, 'SKILL.md'), `# ${directory}\n`);
  }
  const resolver = await SkillResolver.open(root);

  const first = await resolver.resolve(
    'portable',
    'implementer',
    ['team-a/review', 'team-b/review'],
    repo,
  );
  const second = await resolver.resolve(
    'portable',
    'implementer',
    ['team-a/review', 'team-b/review'],
    repo,
  );
  const firstProjectIds = first.filter((skill) => skill.skill_id.startsWith('project-')).map((skill) => skill.skill_id);
  const secondProjectIds = second.filter((skill) => skill.skill_id.startsWith('project-')).map((skill) => skill.skill_id);

  assert.equal(new Set(firstProjectIds).size, 2);
  assert.deepEqual(secondProjectIds, firstProjectIds);
});

test('tree fingerprints detect resource content and executable mode changes', async () => {
  const root = await fixtureRoot();
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-project-skill-'));
  const skillRoot = join(repo, 'skills', 'build');
  await mkdir(join(skillRoot, 'scripts'), { recursive: true });
  await writeFile(join(skillRoot, 'SKILL.md'), '# Build\n');
  await writeFile(join(skillRoot, 'scripts', 'check.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
  const resolver = await SkillResolver.open(root);
  const skill = (await resolver.resolve('portable', 'implementer', ['skills/build'], repo)).at(-1)!;

  assert.match(skill.tree_sha256 ?? '', /^[a-f0-9]{64}$/);
  await writeFile(join(skillRoot, 'scripts', 'check.sh'), '#!/bin/sh\nexit 1\n');
  await assert.rejects(resolver.verify(skill), /tree hash/i);

  const refreshed = (await resolver.resolve('portable', 'implementer', ['skills/build'], repo)).at(-1)!;
  await chmod(join(skillRoot, 'scripts', 'check.sh'), 0o755);
  await assert.rejects(resolver.verify(refreshed), /tree hash/i);

  const modeRefreshed = (await resolver.resolve('portable', 'implementer', ['skills/build'], repo)).at(-1)!;
  await chmod(skillRoot, 0o700);
  await assert.rejects(resolver.verify(modeRefreshed), /tree hash/i);
});

test('tree fingerprints cover symlink targets and reject external symlinks', async () => {
  const root = await fixtureRoot();
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-project-skill-'));
  const skillRoot = join(repo, 'skills', 'linked');
  await mkdir(skillRoot, { recursive: true });
  await writeFile(join(skillRoot, 'SKILL.md'), '# Linked\n');
  await writeFile(join(skillRoot, 'a.txt'), 'same\n');
  await writeFile(join(skillRoot, 'b.txt'), 'same\n');
  await symlink('a.txt', join(skillRoot, 'current.txt'));
  const resolver = await SkillResolver.open(root);
  const skill = (await resolver.resolve('portable', 'implementer', ['skills/linked'], repo)).at(-1)!;

  await unlink(join(skillRoot, 'current.txt'));
  await symlink('b.txt', join(skillRoot, 'current.txt'));
  await assert.rejects(resolver.verify(skill), /tree hash/i);

  await unlink(join(skillRoot, 'current.txt'));
  await symlink('../../outside.txt', join(skillRoot, 'current.txt'));
  await writeFile(join(repo, 'outside.txt'), 'outside\n');
  await assert.rejects(
    resolver.resolve('portable', 'implementer', ['skills/linked'], repo),
    /symlink.*outside|escapes.*skill/i,
  );

  await unlink(join(skillRoot, 'current.txt'));
  await symlink('../../outside.txt', join(skillRoot, 'indirect.txt'));
  await symlink('indirect.txt', join(skillRoot, 'current.txt'));
  await assert.rejects(
    resolver.resolve('portable', 'implementer', ['skills/linked'], repo),
    /symlink.*outside|escapes.*skill/i,
  );
});

test('snapshots preserve internal symlinks and reject an existing corrupted tree', async () => {
  const root = await fixtureRoot();
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-project-skill-'));
  const skillRoot = join(repo, 'skills', 'snapshot');
  await mkdir(skillRoot, { recursive: true });
  await writeFile(join(skillRoot, 'SKILL.md'), '# Snapshot\n');
  await writeFile(join(skillRoot, 'resource.txt'), 'resource\n');
  await symlink('resource.txt', join(skillRoot, 'resource-link.txt'));
  const resolver = await SkillResolver.open(root);
  const skill = (await resolver.resolve('portable', 'implementer', ['skills/snapshot'], repo)).at(-1)!;

  const destination = await resolver.snapshotForRun(repo, 'run-1', [skill]);
  const copiedLink = join(destination, skill.skill_id, 'resource-link.txt');
  assert.equal((await lstat(copiedLink)).isSymbolicLink(), true);
  assert.equal(await readlink(copiedLink), 'resource.txt');

  await writeFile(join(destination, skill.skill_id, 'resource.txt'), 'corrupted\n');
  await assert.rejects(resolver.snapshotForRun(repo, 'run-1', [skill]), /tree hash/i);

  await rm(repo, { recursive: true, force: true });
});
