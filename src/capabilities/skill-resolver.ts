import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ProfileName } from '../domain/types.js';

export interface ResolvedSkill {
  skill_id: string;
  root: string;
  entry: string;
  sha256: string;
  tree_sha256?: string;
  resources: string[];
}

interface SkillLockEntry {
  path: string;
  entry: string;
  sha256: string;
  resources?: string[];
}

interface SkillLockFile {
  version: number;
  skills: Record<string, SkillLockEntry>;
}

interface ProfileDefinition {
  extends?: ProfileName;
  skills?: string[];
  requires?: string[];
}

interface ProfilesFile {
  profiles: Record<string, ProfileDefinition>;
}

interface RoleSkillsFile {
  roles: Record<
    string,
    {
      skills?: string[];
      profile_skills?: Partial<Record<ProfileName, string[]>>;
    }
  >;
}

export interface SkillResolverOptions {
  lockFile?: string;
  profilesFile?: string;
  roleSkillsFile?: string;
}

function containedPath(root: string, relativePath: string): string {
  const candidate = resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}/`) && !candidate.startsWith(`${root}\\`)) {
    throw new Error(`skill path escapes plugin root: ${relativePath}`);
  }
  return candidate;
}

async function fileHash(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

async function treeHash(root: string): Promise<string> {
  const rootDetails = await lstat(root);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw new Error(`skill root must be a real directory: ${root}`);
  }

  const records: Array<Record<string, string | number>> = [
    { path: '.', type: 'directory', mode: rootDetails.mode & 0o7777 },
  ];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const details = await lstat(path);
      const relativePath = relative(root, path).split(sep).join('/');
      const mode = details.mode & 0o7777;
      if (details.isSymbolicLink()) {
        const target = await readlink(path);
        const resolvedTarget = resolve(dirname(path), target);
        if (!isContained(root, resolvedTarget)) {
          throw new Error(`symlink escapes skill root: ${relativePath} -> ${target}`);
        }
        records.push({ path: relativePath, type: 'symlink', mode, target });
      } else if (details.isDirectory()) {
        records.push({ path: relativePath, type: 'directory', mode });
        await visit(path);
      } else if (details.isFile()) {
        records.push({
          path: relativePath,
          type: 'file',
          mode,
          sha256: await fileHash(path),
        });
      } else {
        throw new Error(`unsupported entry in skill tree: ${relativePath}`);
      }
    }
  };

  await visit(root);
  return createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

export async function verifyResolvedSkill(skill: ResolvedSkill): Promise<void> {
  const entryPath = containedPath(skill.root, skill.entry);
  const actual = await fileHash(entryPath);
  if (actual !== skill.sha256) {
    throw new Error(`skill hash mismatch for ${skill.skill_id}`);
  }
  const actualTreeHash = await treeHash(skill.root);
  if (skill.tree_sha256 !== undefined && actualTreeHash !== skill.tree_sha256) {
    throw new Error(`skill tree hash mismatch for ${skill.skill_id}`);
  }
  for (const resource of skill.resources) {
    containedPath(skill.root, resource);
  }
}

export async function verifyResolvedSkills(skills: ResolvedSkill[]): Promise<void> {
  for (const skill of skills) {
    await verifyResolvedSkill(skill);
  }
}

function projectSkillId(base: string, root: string): string {
  const relativeRoot = relative(base, root).split(sep).join('/') || '.';
  const slug = basename(root).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
  const pathDigest = createHash('sha256').update(relativeRoot).digest('hex').slice(0, 12);
  return `project-${slug}-${pathDigest}`;
}

export class SkillResolver {
  private readonly pluginRoot: string;
  private readonly lockFile: string;
  private readonly profilesFile: string;
  private readonly roleSkillsFile: string;
  private lock?: SkillLockFile;
  private profiles?: ProfilesFile;
  private roleSkills?: RoleSkillsFile;

  private constructor(pluginRoot: string, options: SkillResolverOptions) {
    this.pluginRoot = resolve(pluginRoot);
    this.lockFile = options.lockFile ?? join(this.pluginRoot, 'capabilities', 'skills.lock.yaml');
    this.profilesFile = options.profilesFile ?? join(this.pluginRoot, 'capabilities', 'profiles.yaml');
    this.roleSkillsFile =
      options.roleSkillsFile ?? join(this.pluginRoot, 'capabilities', 'role-skills.yaml');
  }

  static async open(pluginRoot: string, options: SkillResolverOptions = {}): Promise<SkillResolver> {
    const resolver = new SkillResolver(pluginRoot, options);
    await resolver.load();
    return resolver;
  }

  private async load(): Promise<void> {
    this.lock = parseYaml(await readFile(this.lockFile, 'utf8')) as SkillLockFile;
    this.profiles = parseYaml(await readFile(this.profilesFile, 'utf8')) as ProfilesFile;
    this.roleSkills = parseYaml(await readFile(this.roleSkillsFile, 'utf8')) as RoleSkillsFile;

    if (this.lock?.version !== 1 || this.lock.skills === undefined) {
      throw new Error('unsupported or invalid skills.lock.yaml');
    }
    if (!this.profiles?.profiles) {
      throw new Error('invalid profiles.yaml');
    }
    if (!this.roleSkills?.roles) {
      throw new Error('invalid role-skills.yaml');
    }
  }

  requiredExternalCapabilities(profile: ProfileName): string[] {
    const definitions = this.resolveProfileDefinitions(profile);
    return [...new Set(definitions.flatMap((definition) => definition.requires ?? []))];
  }

  private resolveProfileDefinitions(profile: ProfileName): ProfileDefinition[] {
    const definition = this.profiles?.profiles[profile];
    if (definition === undefined) {
      throw new Error(`unknown capability profile: ${profile}`);
    }
    if (definition.extends === undefined) {
      return [definition];
    }
    return [...this.resolveProfileDefinitions(definition.extends), definition];
  }

  async resolve(
    profile: ProfileName,
    role: string,
    projectSkills: string[],
    projectRoot?: string,
  ): Promise<ResolvedSkill[]> {
    const profileSkills = this.resolveProfileDefinitions(profile).flatMap(
      (definition) => definition.skills ?? [],
    );
    const roleDefinition = this.roleSkills?.roles[role];
    if (roleDefinition === undefined) {
      throw new Error(`unknown worker role: ${role}`);
    }

    const skillIds = [
      ...new Set([
        ...profileSkills,
        ...(roleDefinition.skills ?? []),
        ...(roleDefinition.profile_skills?.[profile] ?? []),
      ]),
    ];
    const resolved = await Promise.all(
      skillIds.map(async (skillId) => this.resolveLockedSkill(skillId)),
    );
    for (const projectSkill of projectSkills) {
      resolved.push(await this.resolveProjectSkill(projectSkill, projectRoot));
    }
    return resolved;
  }

  private async resolveLockedSkill(skillId: string): Promise<ResolvedSkill> {
    const entry = this.lock?.skills[skillId];
    if (entry === undefined) {
      throw new Error(`missing locked skill: ${skillId}`);
    }
    const root = containedPath(this.pluginRoot, entry.path);
    return {
      skill_id: skillId,
      root,
      entry: entry.entry,
      sha256: entry.sha256,
      tree_sha256: await treeHash(root),
      resources: entry.resources ?? [],
    };
  }

  private async resolveProjectSkill(
    projectSkill: string,
    projectRoot = process.cwd(),
  ): Promise<ResolvedSkill> {
    const base = await realpath(resolve(projectRoot));
    const requestedRoot = isAbsolute(projectSkill)
      ? resolve(projectSkill)
      : resolve(base, projectSkill);
    if (!isContained(base, requestedRoot)) {
      throw new Error(`project Skill path escapes project root: ${projectSkill}`);
    }
    const root = await realpath(requestedRoot);
    if (!isContained(base, root)) {
      throw new Error(`project Skill symlink escapes project root: ${projectSkill}`);
    }
    const entry = 'SKILL.md';
    return {
      skill_id: projectSkillId(base, root),
      root,
      entry,
      sha256: await fileHash(join(root, entry)),
      tree_sha256: await treeHash(root),
      resources: [],
    };
  }

  async verify(skill: ResolvedSkill): Promise<void> {
    await verifyResolvedSkill(skill);
  }

  async verifyAll(skills: ResolvedSkill[]): Promise<void> {
    await verifyResolvedSkills(skills);
  }

  async snapshotForRun(
    repoRoot: string,
    runId: string,
    skills: ResolvedSkill[],
  ): Promise<string> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
      throw new Error(`invalid run id: ${runId}`);
    }
    const destination = join(repoRoot, '.delivery', 'runs', runId, 'runtime-skills');
    await mkdir(destination, { recursive: true });
    for (const skill of skills) {
      await this.verify(skill);
      const target = join(destination, skill.skill_id);
      if (!target.startsWith(`${destination}/`) && !target.startsWith(`${destination}\\`)) {
        throw new Error(`invalid skill snapshot path: ${skill.skill_id}`);
      }
      let targetExists = true;
      try {
        await lstat(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        targetExists = false;
      }
      if (!targetExists) {
        await cp(skill.root, target, {
          recursive: true,
          force: false,
          dereference: false,
          verbatimSymlinks: true,
        });
      }
      await this.verify({ ...skill, root: target });
    }
    return destination;
  }
}

export function skillSourceDirectory(entryPath: string): string {
  return dirname(entryPath);
}
