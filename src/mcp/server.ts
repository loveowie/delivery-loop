import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DeliveryToolService } from './tools.js';

function result(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

export function createMcpServer(service: DeliveryToolService): McpServer {
  const server = new McpServer({
    name: 'delivery-loop',
    version: '0.1.0',
  });

  server.registerTool(
    'delivery_start',
    {
      title: 'Start delivery run',
      description: 'Start an approved end-to-end delivery run from a prepared specification directory.',
      inputSchema: {
        repo_root: z.string().min(1),
        prepared_directory: z.string().min(1),
        run_id: z.string().min(1).optional(),
        config_override: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (input) =>
      result(
        await service.delivery_start({
          ...input,
          ...(input.config_override === undefined
            ? {}
            : { config_override: input.config_override as never }),
        }),
      ),
  );

  server.registerTool(
    'delivery_status',
    {
      title: 'Delivery status',
      description: 'Return a bounded status summary and the latest ten audit events.',
      inputSchema: {
        run_id: z.string().min(1),
        repo_root: z.string().min(1).optional(),
      },
    },
    async (input) => result(await service.delivery_status(input)),
  );

  server.registerTool(
    'delivery_watch',
    {
      title: 'Wait for delivery progress',
      description: 'Wait for a state change or the supplied timeout, then return the current summary.',
      inputSchema: {
        run_id: z.string().min(1),
        repo_root: z.string().min(1).optional(),
        timeout_ms: z.number().int().min(1).max(300_000).optional(),
      },
    },
    async (input) => result(await service.delivery_watch(input)),
  );

  server.registerTool(
    'delivery_respond',
    {
      title: 'Respond to decision',
      description: 'Answer a pending human decision by decision id.',
      inputSchema: {
        run_id: z.string().min(1),
        decision_id: z.string().min(1),
        response: z.string().min(1),
        repo_root: z.string().min(1).optional(),
      },
    },
    async (input) => result(await service.delivery_respond(input)),
  );

  for (const [name, method] of [
    ['delivery_pause', service.delivery_pause.bind(service)],
    ['delivery_resume', service.delivery_resume.bind(service)],
    ['delivery_cancel', service.delivery_cancel.bind(service)],
  ] as const) {
    server.registerTool(
      name,
      {
        title: name,
        description: `${name} a delivery run by id.`,
        inputSchema: {
          run_id: z.string().min(1),
          repo_root: z.string().min(1).optional(),
        },
      },
      async (input) => result(await method(input)),
    );
  }

  server.registerTool(
    'delivery_export_report',
    {
      title: 'Export delivery report',
      description: 'Write a Markdown delivery report into the run directory.',
      inputSchema: {
        run_id: z.string().min(1),
        repo_root: z.string().min(1),
      },
    },
    async (input) => result(await service.delivery_export_report(input)),
  );

  server.registerTool(
    'delivery_finalize',
    {
      title: 'Finalize delivery',
      description: 'Apply an explicitly confirmed post-completion Git action. Defaults to prepare-only.',
      inputSchema: {
        run_id: z.string().min(1),
        repo_root: z.string().min(1).optional(),
        mode: z.enum(['prepare-only', 'commit', 'branch', 'push', 'merge']),
        confirmation: z.string().min(1),
      },
    },
    async (input) => result(await service.delivery_finalize(input)),
  );

  return server;
}
