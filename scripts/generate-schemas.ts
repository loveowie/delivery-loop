import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  AgentRequestSchema,
  AgentResultSchema,
  DeliveryConfigSchema,
  TaskGraphSchema,
} from '../src/domain/schemas.js';

const outputDirectory = join(process.cwd(), 'schemas');
await mkdir(outputDirectory, { recursive: true });

const schemas = {
  'delivery-config.schema.json': DeliveryConfigSchema,
  'task.schema.json': TaskGraphSchema,
  'agent-request.schema.json': AgentRequestSchema,
  'agent-result.schema.json': AgentResultSchema,
} as const;

for (const [fileName, schema] of Object.entries(schemas)) {
  await writeFile(
    join(outputDirectory, fileName),
    `${JSON.stringify(z.toJSONSchema(schema, { target: 'draft-2020-12' }), null, 2)}\n`,
    'utf8',
  );
}
