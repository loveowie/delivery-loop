import { createHash } from 'node:crypto';

export interface FailureFingerprintInput {
  taskId: string;
  command: string;
  output: string;
}

function normalizeFailureOutput(output: string): string {
  return output
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, '<timestamp>')
    .replace(/0x[0-9a-f]+/gi, '<address>')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(0, 12)
    .join('\n');
}

export function failureFingerprint(input: FailureFingerprintInput): string {
  return createHash('sha256')
    .update(input.taskId)
    .update('\0')
    .update(input.command)
    .update('\0')
    .update(normalizeFailureOutput(input.output))
    .digest('hex');
}
