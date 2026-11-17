import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { SkillResolver, verifyResolvedSkills } from '../capabilities/skill-resolver.js';
import type { ResolvedSkill } from '../capabilities/skill-resolver.js';
import { DeliveryController } from '../controller/delivery-controller.js';
import type { SkillProvider } from '../controller/delivery-controller.js';
import { EvidenceLedger } from '../state/evidence-ledger.js';
import { StateStore } from '../state/state-store.js';
import type { WorkerAdapter } from '../workers/worker-adapter.js';
import { CommandRunner } from '../verification/command-runner.js';
import { GuardedGitAdapter, createNodeGitExecutor } from '../workspace/git-adapter.js';
import type { GitCommandResult, GitExecutionOptions } from '../workspace/git-adapter.js';
import { PatchIntegrationAdapter } from '../workspace/patch-integration-adapter.js';
import { PatchIntegrator } from '../workspace/patch-integrator.js';
import { createCodeSnapshot } from '../workspace/repository-context.js';
import type { GitInspector } from '../workspace/repository-context.js';
import { WorktreeManager, assertManagedWorktree } from '../workspace/worktree-manager.js';
import { NodeCommandProbe, runPreflight } from './preflight.js';
import type { CommandProbe } from './preflight.js';

export interface RuntimeFactoryOptions {
  pluginRoot: string;
  probe?: CommandProbe;
  gitExecutor?: (args: string[], cwd?: string, options?: GitExecutionOptions) => Promise<GitCommandResult>;
  /** DSH-native worker backend; required for every run. */
  workerAdapter: WorkerAdapter;
}

export interface DeliveryRuntime {
  controller: DeliveryController;
  store: StateStore;
  skillResolver: SkillProvider;
  evidenceLedger: EvidenceLedger;
}

const ROLES = ['planner', 'implementer', 'test_author', 'debugger', 'reviewer', 'acceptance'] as const;

export class RuntimeFactory {
  private readonly options: RuntimeFactoryOptions;

  constructor(options: RuntimeFactoryOptions) {
    this.options = options;
  }

  async create(repoRoot: string, runId: string): Promise<DeliveryRuntime> {
    const store = await StateStore.open(repoRoot);
    const state = await store.readRun(runId);
    if (state === undefined) {
      throw new Error(`run not found: ${runId}`);
    }
    const bundlePath = join(store.getRunDirectory(runId), 'runtime-bundle.json');
    let frozen: { runtime_bundle_id: string; skills: ResolvedSkill[]; role_assignments: Record<string, string[]> } | undefined;
    try {
      frozen = JSON.parse(await readFile(bundlePath, 'utf8'));
      if (frozen?.role_assignments === undefined) throw new Error('legacy runtime bundle lacks frozen role assignments; explicit migration required');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (frozen === undefined) {
      const skillResolver = await SkillResolver.open(this.options.pluginRoot, {
        profilesFile: join(this.options.pluginRoot, state.config.capabilities.profiles_file),
        roleSkillsFile: join(this.options.pluginRoot, state.config.capabilities.role_skills_file),
      });
      const roleAssignments: Record<string, string[]> = {};
      const resolved: ResolvedSkill[] = [];
      for (const role of ROLES) {
        const roleSkills = await skillResolver.resolve(state.config.profile, role, state.config.capabilities.project_skills, state.repo_root);
        roleAssignments[role] = roleSkills.map(skill => skill.skill_id);
        resolved.push(...roleSkills);
      }
      const uniqueSkills = [...new Map(resolved.map(skill => [skill.skill_id, skill])).values()].sort((a,b) => a.skill_id.localeCompare(b.skill_id));
      await skillResolver.verifyAll(uniqueSkills);
      const runtimeSkillsDirectory = await skillResolver.snapshotForRun(repoRoot, runId, uniqueSkills);
      const skills = uniqueSkills.map(skill => ({ ...skill, root: join(runtimeSkillsDirectory, skill.skill_id) }));
      frozen = {
        runtime_bundle_id: createHash('sha256').update(JSON.stringify({ skills, roleAssignments })).digest('hex'),
        skills,
        role_assignments: roleAssignments,
      };
      await store.writeArtifact(runId, 'runtime-bundle.json', `${JSON.stringify(frozen, null, 2)}\n`);
      await store.writeArtifact(runId, 'runtime-skills-path.txt', `${runtimeSkillsDirectory}\n`);
    }
    const bundle = frozen;
    const runtimeSkillProvider: SkillProvider = {
      resolve: async (profile, role) => {
        if (profile !== state.config.profile) throw new Error('task capability profile differs from frozen run profile');
        const ids = bundle.role_assignments[role];
        if (ids === undefined) throw new Error(`unknown frozen role: ${role}`);
        return ids.map(id => {
          const skill = bundle.skills.find(item => item.skill_id === id);
          if (skill === undefined) throw new Error(`frozen skill missing: ${id}`);
          return structuredClone(skill);
        });
      },
      verifyAll: async (skills) => await verifyResolvedSkills(skills),
    };
    await runPreflight(
      state.config,
      this.options.probe ?? new NodeCommandProbe(),
      runtimeSkillProvider,
      state.repo_root,
    );

    const git = new GuardedGitAdapter(
      this.options.gitExecutor ?? createNodeGitExecutor(),
    );
    const patchIntegrator = new PatchIntegrator(git);
    const worktrees = new WorktreeManager(repoRoot, git, patchIntegrator);
    const evidenceLedger = new EvidenceLedger(repoRoot);
    const inspector: GitInspector = {
      async exec(args, cwd) {
        return (await git.exec(args, cwd)).stdout;
      },
    };
    const snapshots = {
      async create(workdir: string, baselineCommit: string) {
        // Controller snapshots are only taken in managed worktrees. Revalidate
        // on every snapshot so a worker cannot redirect the controller's git
        // commands into the real checkout by touching the worktree .git file.
        if (resolve(workdir) !== resolve(repoRoot)) {
          await assertManagedWorktree(workdir, repoRoot, baselineCommit, git);
        }
        return await createCodeSnapshot(workdir, inspector);
      },
      async changedFiles(workdir: string) {
        const status = await git.exec(
          ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
          workdir,
        );
        return status.stdout
          .split('\0')
          .filter((entry) => entry.length > 3)
          .map((entry) => entry.slice(3))
          .filter((path) => path !== '.delivery' && !path.startsWith('.delivery/'));
      },
    };
    const runDirectory = store.getRunDirectory(runId);
    const integrator = new PatchIntegrationAdapter({
      worktrees,
      patchIntegrator,
      snapshots,
      runDirectory,
    });
    const workerAdapter = this.options.workerAdapter;

    const controller = new DeliveryController({
      repoRoot,
      store,
      workers: workerAdapter,
      skills: runtimeSkillProvider,
      worktrees,
      snapshots,
      verifier: new CommandRunner(repoRoot, { terminationGraceMs: state.config.runtime.worker_termination_grace_seconds * 1000, execution: state.config.verification.execution ?? { backend: 'container' } }),
      integrator,
      evidenceLedger,
    });
    return { controller, store, skillResolver: runtimeSkillProvider, evidenceLedger };
  }
}
