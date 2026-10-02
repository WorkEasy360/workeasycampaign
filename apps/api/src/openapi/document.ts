import { z } from 'zod';
import { ROUTES } from './routes.js';

const errorSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'requestId'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        fields: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
        requestId: { type: 'string', format: 'uuid' },
      },
    },
  },
};

export function buildOpenApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of ROUTES) {
    const params = [...route.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: 'string', format: 'uuid' },
    }));
    const query = route.query
      ? Object.entries((z.toJSONSchema(route.query, { io: 'input' }) as { properties?: Record<string, unknown> }).properties ?? {}).map(
          ([name, schema]) => ({ name, in: 'query', required: false, schema }),
        )
      : [];
    const headers = [
      ...(route.method !== 'GET' ? [{ name: 'X-CSRF-Token', in: 'header', required: true, schema: { type: 'string' } }] : []),
      ...(route.idempotent ? [{ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', minLength: 8, maxLength: 128 } }] : []),
    ];
    (paths[route.path] ??= {})[route.method.toLowerCase()] = {
      tags: [route.tag],
      summary: route.summary,
      description: `Access: \`${route.access}\``,
      security: route.access === 'public' ? [] : [{ session: [] }],
      parameters: [...params, ...query, ...headers],
      ...(route.body
        ? { requestBody: { required: true, content: { 'application/json': { schema: z.toJSONSchema(route.body, { io: 'input' }) } } } }
        : {}),
      responses: {
        [route.success]: { description: 'Success' },
        default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Workeasy Campaign API',
      version: '0.4.0',
      description:
        'Browser API. Cookie session + X-CSRF-Token on state-changing requests. Errors use one shape (Error). ' +
        'Organization/workspace routes answer 404 to non-members and 403 to members lacking the permission.',
    },
    servers: [{ url: '/api' }],
    components: {
      securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'wk_session' } },
      schemas: { Error: errorSchema },
    },
    paths,
  };
}
