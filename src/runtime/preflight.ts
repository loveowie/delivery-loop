import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DeliveryConfig } from '../domain/types.js';
import type { SkillProvider } from '../controller/delivery-controller.js';

const execFileAsync = promisify(execFile);

export interface CommandProbe {
  version(command: string): Promise<string | undefined>;
}

export class NodeCommandProbe implements CommandProbe {
  async version(command: string): Promise<string | undefined> {
    try {
      const result = await execFileAsync(command, ['--version'], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });
      return result.stdout.trim();
    } catch {
      return undefined;
    }
  }
}

function parseVersion(value: string): number[] | undefined {
  const match = value.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === undefined || b === undefined) {
    throw new Error(`cannot compare versions: ${left} and ${right}`);
  }
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export async function runPreflight(
  config: DeliveryConfig,
  probe: CommandProbe,
  skills: SkillProvider,
  repoRoot?: string,
): Promise<void> {
  const codexVersion = await probe.version('codex');
  if (codexVersion === undefined) {
    throw new Error('codex CLI is not available on PATH');
  }

  if (config.spec.provider === 'openspec') {
    const openspecVersion = await probe.version('openspec');
    const minimum = config.spec.minimum_cli_version ?? '0.0.0';
    if (openspecVersion === undefined) {
      throw new Error(`openspec CLI is required by the openspec provider; minimum ${minimum}`);
    }
    if (compareVersions(openspecVersion, minimum) < 0) {
      throw new Error(
        `openspec CLI ${openspecVersion} is below required minimum ${minimum}`,
      );
    }
  }

  for (const role of ['planner', 'implementer', 'test_author', 'debugger', 'reviewer', 'acceptance']) {
    const resolved = await skills.resolve(
      config.profile,
      role,
      config.capabilities.project_skills,
      repoRoot,
    );
    await skills.verifyAll(resolved);
  }
}
