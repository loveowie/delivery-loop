import type { RequiredOutput } from '../domain/types.js';

function normalize(path: string): string {
  return path.replaceAll('\\', '/');
}

function isTest(path: string): boolean {
  return (
    /(^|\/)(__tests__|tests?|spec)\//i.test(path) ||
    /\.(test|spec)\.[^.]+$/i.test(path)
  );
}

function isDocumentation(path: string): boolean {
  return /(^|\/)docs?\//i.test(path) || /(^|\/)readme(?:\.[^/]+)?$/i.test(path) || /\.(md|mdx|rst|adoc)$/i.test(path);
}

function isMigration(path: string): boolean {
  return /(^|\/)(migrations?|db\/migrate|sql)\//i.test(path) || /\.sql$/i.test(path);
}

function isConfiguration(path: string): boolean {
  return (
    /(^|\/)(config|configuration|settings)(?:\.[^/]+)?$/i.test(path) ||
    /\.(ya?ml|toml|ini|conf|properties)$/i.test(path)
  );
}

function matches(output: RequiredOutput, path: string): boolean {
  switch (output) {
    case 'code':
      return !isTest(path) && !isDocumentation(path) && !isMigration(path) && !isConfiguration(path);
    case 'test':
      return isTest(path);
    case 'documentation':
      return isDocumentation(path);
    case 'migration':
      return isMigration(path);
    case 'configuration':
      return isConfiguration(path);
  }
}

export function missingRequiredOutputs(
  required: RequiredOutput[],
  changedFiles: string[],
): RequiredOutput[] {
  const files = changedFiles.map(normalize);
  return required.filter((output) => !files.some((file) => matches(output, file)));
}
