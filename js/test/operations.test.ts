import { expect, test } from 'vitest';

import { ContractError, JSON_SCHEMA_DIALECT, parseCatalog } from '../src/core/index.js';
import { type DiagnosticEvent, observe } from '../src/operations/diagnostics.js';
import {
  createValidationSession,
  lazyCatalog,
  VALIDATION_LIMITS,
} from '../src/operations/index.js';
import {
  catalogCompiler,
  catalogProgram,
  compileProgram,
  registerProgram,
} from '../src/operations/program.js';

const id = 'urn:operational:1';
function catalog(schema: unknown = { type: 'integer', minimum: 0 }) {
  return parseCatalog({
    contracts: [
      {
        id,
        input: {
          presence: 'required',
          representations: [
            {
              id: 'json',
              mediaType: 'application/json',
              schema: {
                mediaType: 'application/schema+json',
                dialect: JSON_SCHEMA_DIALECT,
                inline: schema,
              },
            },
          ],
        },
        output: { presence: 'none' },
      },
    ],
  });
}
const valid = { contractId: id, direction: 'input', representationId: 'json', value: 2 };
test('built worker validates independently and cleanup is physical on success/refusal', async () => {
  const session = createValidationSession(catalog());
  expect(await session.run('validate', valid)).toBe(2);
  expect(session.active).toBe(0);
  await expect(
    session.run('validate', { ...valid, value: 'secret-payload' }),
  ).rejects.toMatchObject({
    code: 'INSTANCE_INVALID',
    detail: { contractId: id, direction: 'input' },
  });
  expect(session.active).toBe(0);
  const capabilities = await session.run<unknown[]>('capabilities', {});
  expect(capabilities).toHaveLength(2);
  await session.close();
  await expect(session.run('validate', valid)).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
});
test('hostile exponential recursive validation has an enforceable deadline and leaves the event loop responsive', async () => {
  const branch = {
    type: 'object',
    required: ['child'],
    properties: { child: { allOf: [{ $ref: '#/$defs/branch' }, { $ref: '#/$defs/branch' }] } },
  };
  const schema = {
    $defs: { branch: { anyOf: [{ type: 'null' }, branch] } },
    $ref: '#/$defs/branch',
  };
  let value: unknown = null;
  for (let i = 0; i < 25; i++) value = { child: value };
  const session = createValidationSession(catalog(schema), { deadlineMs: 300 });
  let beats = 0;
  const pulse = setInterval(() => beats++, 10);
  const start = performance.now();
  try {
    await expect(session.run('validate', { ...valid, value })).rejects.toMatchObject({
      code: 'VALIDATION_TIMEOUT',
    });
    expect(performance.now() - start).toBeLessThan(1500);
    expect(beats).toBeGreaterThan(2);
    expect(session.active).toBe(0);
  } finally {
    clearInterval(pulse);
    await session.close();
  }
});
test('abort, capacity exhaustion and close terminate concurrent workers without leaking secret reasons', async () => {
  const events: DiagnosticEvent[] = [];
  const session = createValidationSession(catalog(), {
    concurrent: 1,
    diagnostics: (event) => events.push(event),
  });
  const controller = new AbortController();
  const pending = session
    .run('validate', valid, { signal: controller.signal })
    .catch((error: unknown) => error);
  expect(session.active).toBe(1);
  await expect(session.run('validate', valid)).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
  controller.abort(new Error('secret-abort-reason'));
  expect(await pending).toMatchObject({ code: 'VALIDATION_ABORTED' });
  expect(session.active).toBe(0);
  const closing = session.run('validate', valid).catch((error: unknown) => error);
  await session.close();
  expect(await closing).toMatchObject({ code: 'VALIDATION_ABORTED' });
  expect(session.active).toBe(0);
  expect(JSON.stringify(events)).not.toContain('secret');
  expect(events.every((event) => event.durationMs >= 0 && event.correlationId.length > 0)).toBe(
    true,
  );
});
test('pre-aborted requests, invalid limits and non-JSON inputs do not start workers', async () => {
  for (const limits of [
    { deadlineMs: 0 },
    { deadlineMs: VALIDATION_LIMITS.deadlineMs + 1 },
    { concurrent: 0 },
    { concurrent: 5 },
    { concurrent: 1.5 },
  ])
    expect(() => createValidationSession(catalog(), limits)).toThrow(TypeError);
  const session = createValidationSession(catalog());
  await expect(
    session.run('validate', valid, { signal: AbortSignal.abort('secret') }),
  ).rejects.toMatchObject({ code: 'VALIDATION_ABORTED' });
  await expect(session.run('validate', { ...valid, value: undefined })).rejects.toMatchObject({
    code: 'NON_JSON_VALUE',
  });
  expect(session.active).toBe(0);
  await session.close();
});
test('unsupported schema assertions, vocabularies and regex are refused in the built worker', async () => {
  for (const [schema, code] of [
    [{ custom: true }, 'UNSUPPORTED_KEYWORD'],
    [{ $vocabulary: { 'urn:unknown:vocab:1': true } }, 'UNSUPPORTED_VOCABULARY'],
    [{ type: 'string', pattern: '(a+)+$' }, 'UNSUPPORTED_REGEX'],
  ] as const) {
    const session = createValidationSession(catalog(schema));
    await expect(session.run('validate', valid)).rejects.toMatchObject({ code });
    await session.close();
  }
});
test('worker compilation failures are sanitized and direct programs are registered independently', async () => {
  const session = createValidationSession({ contracts: [] });
  await expect(
    session.run('compile', { entry: 'urn:missing:1', documents: [] }),
  ).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });
  expect(
    await session.run('compile', {
      entry: 'urn:boolean:1',
      documents: [{ uri: 'urn:boolean:1', value: true }],
    }),
  ).toBe(true);
  await session.close();
  const source = catalog();
  expect(catalogProgram(source).contracts).toBe(source.contracts);
  const program = {
    contracts: source.contracts,
    schemas: {
      '["urn:operational:1","input","json"]': {
        entry: 'urn:resolved:1',
        documents: [{ uri: 'urn:resolved:1', value: false }],
      },
    },
  };
  registerProgram(source, program);
  expect(catalogProgram(source)).toBe(program);
  const compile = catalogCompiler(program);
  const context = {
    origin: 'remote' as const,
    contractId: id,
    direction: 'input' as const,
    representationId: 'json',
  };
  const schema = source.contracts[0]!.input.representations![0]!.schema!;
  expect(compile(schema, context)(2)).toBe(false);
  expect(compile(schema, context)).toBe(compile(schema, context));
  const fresh = catalogCompiler({ contracts: [] });
  expect(fresh(schema, context)(2)).toBe(true);
  for (const [descriptor, code] of [
    [{ ...schema, dialect: 'urn:other:1' }, 'UNSUPPORTED_DIALECT'],
    [{ ...schema, mediaType: 'text/plain' }, 'UNSUPPORTED_MEDIA_TYPE'],
    [
      { ...schema, bundle: { uri: 'urn:bundle:1', mediaType: 'application/zip' } },
      'SCHEMA_UNAVAILABLE',
    ],
    [
      {
        mediaType: schema.mediaType,
        dialect: JSON_SCHEMA_DIALECT,
        uri: 'https://example.test/schema',
      },
      'SCHEMA_UNAVAILABLE',
    ],
  ] as const)
    expect(() => catalogCompiler({ contracts: [] })(descriptor, context)).toThrowError(
      new ContractError(code, context),
    );
  expect(() => compileProgram({ entry: 'urn:missing:1', documents: [] }, context)).toThrow(
    ContractError,
  );
});
test('explicit synchronous trusted helpers preserve validation and never hide unsupported selections', () => {
  const source = catalog();
  const lazy = lazyCatalog(source);
  expect(lazy.getContract(id).id).toBe(id);
  expect(lazy.capabilities(id, 'input')[0]?.supported).toBe(true);
  const rep = lazy.select(id, 'input', 'json');
  expect(rep.validate(2)).toBe(2);
  expect(() => rep.validate(-1, 'remote')).toThrow(ContractError);
  expect(() => lazy.select(id, 'input', 'unknown', 'remote')).toThrow(ContractError);
});
test('diagnostic hooks receive allowlisted facts, retain correlation, and cannot alter outcomes', async () => {
  const events: DiagnosticEvent[] = [];
  expect(
    await observe(
      'discovery',
      (event) => events.push(event),
      () => Promise.resolve(3),
      'correlation',
    ),
  ).toBe(3);
  const error = new ContractError('INSTANCE_INVALID', { origin: 'remote' });
  await expect(
    observe(
      'resolution',
      (event) => {
        events.push(event);
        throw new Error('secret-hook');
      },
      () => Promise.reject(error),
    ),
  ).rejects.toBe(error);
  expect(
    await observe(
      'validation',
      () => {
        throw new Error('secret');
      },
      () => Promise.resolve(true),
    ),
  ).toBe(true);
  await expect(
    observe(
      'negotiation',
      (event) => events.push(event),
      () => Promise.reject(new Error('secret-business')),
    ),
  ).rejects.toThrow('secret-business');
  expect(events[0]).toMatchObject({ correlationId: 'correlation', outcome: 'success' });
  expect(events[1]).toMatchObject({ outcome: 'rejected', code: 'INSTANCE_INVALID' });
  expect(Object.keys(events[2]!).sort()).toEqual([
    'correlationId',
    'durationMs',
    'operation',
    'outcome',
  ]);
  expect(JSON.stringify(events)).not.toContain('secret');
});

test('branch-error amplification is confined to the worker resource budget', async () => {
  const branch = {
    type: 'object',
    required: ['child'],
    properties: { child: { $ref: '#/$defs/branch' } },
  };
  const schema = { $defs: { branch: { anyOf: [branch, branch] } }, $ref: '#/$defs/branch' };
  let value: unknown = {};
  for (let i = 0; i < 25; i++) value = { child: value };
  const session = createValidationSession(catalog(schema));
  try {
    await expect(session.run('validate', { ...valid, value })).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT',
    });
    expect(session.active).toBe(0);
  } finally {
    await session.close();
  }
});

test('a rejection with undefined reason is still a rejected diagnostic decision', async () => {
  const events: DiagnosticEvent[] = [];
  const pending = Promise.withResolvers<never>();
  pending.reject();
  await expect(
    observe(
      'discovery',
      (event) => events.push(event),
      () => pending.promise,
    ),
  ).rejects.toBeUndefined();
  expect(events[0]?.outcome).toBe('rejected');
});
