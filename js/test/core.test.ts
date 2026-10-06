import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  ContractError,
  EXTENSION_URI,
  JSON_SCHEMA_DIALECT,
  parseCatalog,
  parseExtension,
  parseExtensionParams,
  encodePrimary,
  decodePrimary,
  validateInvocation,
  validateResult,
  matchMediaTypes,
  type ContractCatalog,
  type DiagnosticCode,
  type Direction,
  type CarrierProfile,
} from '../src/core/index.js';
import { snapshot, LIMITS, absoluteUri } from '../src/core/json.js';
import { checkStructure } from '../src/core/structure.js';
import { checkInstance } from '../src/core/schema.js';
import type { ValidateFunction } from 'ajv';

const id = 'urn:example:contract:test:1';
const otherId = 'https://contracts.example.org/other/v2';
const context = { origin: 'local' as const };
function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../vendor/contract/${name}`, import.meta.url), 'utf8'),
  ) as unknown;
}
function representation(schema?: unknown, mediaType = 'application/json'): object {
  return {
    id: 'json',
    mediaType,
    ...(schema === undefined
      ? {}
      : {
          schema: {
            inline: schema,
            mediaType: 'application/schema+json',
            dialect: JSON_SCHEMA_DIALECT,
          },
        }),
  };
}
function rawCatalog(
  schema?: unknown,
  presence = 'required',
  output = 'required',
  mediaType = 'application/json',
): { contracts: object[] } {
  const direction = (presence: string) => ({
    presence,
    ...(presence === 'none' ? {} : { representations: [representation(schema, mediaType)] }),
  });
  return { contracts: [{ id, input: direction(presence), output: direction(output) }] };
}
function catalog(
  schema?: unknown,
  presence = 'required',
  output = 'required',
  mediaType = 'application/json',
): ContractCatalog {
  return parseCatalog(rawCatalog(schema, presence, output, mediaType));
}
function primary(value: unknown = {}, direction: Direction = 'input', rep = 'json'): unknown {
  return {
    data: value,
    mediaType: 'application/json',
    metadata: {
      [EXTENSION_URI]: { contractId: id, direction, representationId: rep, role: 'primary' },
    },
  };
}
const companion = { text: 'trigger' };
const sharedCases = JSON.parse(
  readFileSync(new URL('../../tests/inline-core-cases.json', import.meta.url), 'utf8'),
) as {
  cases: {
    id: string;
    operation: 'validate' | 'encode' | 'decode';
    schema?: unknown;
    value?: unknown;
    parts?: unknown;
    presence?: string;
    mediaType?: string;
    representationId?: string;
    carrier?: CarrierProfile;
    expected: { accepted: boolean; diagnostic?: DiagnosticCode };
  }[];
};
test.each(sharedCases.cases)('shared semantic case: $id', (case_) => {
  const run = () => {
    const parsed = catalog(case_.schema, case_.presence, 'required', case_.mediaType);
    if (case_.operation === 'decode')
      return decodePrimary(parsed, id, 'input', case_.parts, case_.representationId, case_.carrier);
    const selected = parsed.select(id, 'input', 'json');
    if (case_.operation === 'encode') return encodePrimary(selected, case_.value, case_.carrier);
    return selected.validate(case_.value);
  };
  if (case_.expected.accepted) expect(run).not.toThrow();
  else rejected(run, case_.expected.diagnostic!);
});
function metadata(value: unknown): object {
  return { [EXTENSION_URI]: value };
}
function rejected(
  run: () => unknown,
  code: DiagnosticCode,
  origin?: 'local' | 'remote',
): ContractError {
  let error: ContractError | undefined;
  try {
    run();
  } catch (caught) {
    expect(caught).toBeInstanceOf(ContractError);
    error = caught as ContractError;
  }
  expect(error?.code).toBe(code);
  if (origin !== undefined) expect(error?.origin).toBe(origin);
  return error!;
}

describe('pinned structures and discovery', () => {
  test('all 20 normative structural fixtures retain upstream expected decisions', () => {
    const cases = fixture('conformance/cases.json') as {
      catalog: { valid: string[]; invalid: string[] };
    };
    for (const name of cases.catalog.valid)
      checkStructure('catalog', snapshot(fixture(`conformance/${name}`), context), context);
    for (const name of cases.catalog.invalid)
      rejected(
        () => checkStructure('catalog', snapshot(fixture(`conformance/${name}`), context), context),
        'INVALID_STRUCTURE',
      );
    for (const [schema, path] of [
      ['extension-params', 'extension-params-inline'],
      ['extension-params', 'extension-params-external'],
      ['invocation-metadata', 'metadata/invocation-text-to-json'],
      ['invocation-metadata', 'metadata/invocation-no-input'],
      ['result-metadata', 'metadata/result-json'],
      ['result-metadata', 'metadata/result-no-output'],
      ['part-metadata', 'metadata/primary-input-part'],
      ['error-detail', 'metadata/error'],
    ] as const)
      checkStructure(schema, snapshot(fixture(`examples/${path}.json`), context), context);
  });
  test('discovery exposes unfamiliar schemas/alternatives without inventing static domain types', () => {
    const found = parseExtension({
      uri: EXTENSION_URI,
      required: false,
      params: fixture('examples/extension-params-inline.json'),
    });
    expect(found.contracts.length).toBeGreaterThan(0);
    const canonical = parseCatalog(fixture('examples/catalogs/text-to-json.json'));
    expect(canonical.capabilities(canonical.contracts[0]!.id, 'input')[0]!.supported).toBe(true);
    expect(canonical.capabilities(canonical.contracts[0]!.id, 'output')[0]).toMatchObject({
      supported: false,
      diagnostic: 'UNSUPPORTED_MEDIA_TYPE',
    });
    const boolean = parseCatalog(fixture('conformance/valid/boolean-json-schema.json'));
    expect(boolean.select(boolean.contracts[0]!.id, 'input', 'anything-json').validate(null)).toBe(
      null,
    );
    expect(boolean.capabilities(boolean.contracts[0]!.id, 'output')).toEqual([]);
    expect(
      parseExtensionParams({ catalog: { inline: rawCatalog() } }, 'local').contracts[0]!.id,
    ).toBe(id);
    expect(canonical.contracts[0]!.skillIds).toEqual(['extract-contact']);
    rejected(() => canonical.getContract('extract-contact'), 'INVALID_IDENTIFIER');
  });
  test.each([null, {}, { uri: 4 }, { uri: EXTENSION_URI, required: 'true' }])(
    'rejects malformed extension %j',
    (value) => void rejected(() => parseExtension(value), 'INVALID_STRUCTURE', 'remote'),
  );
  test.each([
    'https://w3id.org/a2a-schema-contract/v1',
    'https://w3id.org/a2a-schema-contract/draft/0.2',
  ])(
    'does not fall back from %s',
    (uri) => void rejected(() => parseExtension({ uri }), 'VERSION_MISMATCH'),
  );
  test('external discovery is rejected without fetching', () => {
    rejected(
      () => parseExtensionParams(fixture('examples/extension-params-external.json')),
      'SCHEMA_UNAVAILABLE',
    );
    rejected(
      () =>
        parseExtensionParams({ catalog: { inline: rawCatalog(), uri: 'https://example.org/1' } }),
      'INVALID_STRUCTURE',
    );
  });
  test('catalog shape, ID uniqueness and identifier categories are enforced', () => {
    rejected(() => parseCatalog({}), 'INVALID_STRUCTURE');
    const raw = rawCatalog();
    raw.contracts.push(raw.contracts[0]!);
    rejected(() => parseCatalog(raw), 'DUPLICATE_IDENTIFIER');
    rejected(
      () =>
        parseCatalog({
          contracts: [
            {
              id,
              input: {
                presence: 'required',
                representations: [representation(), representation()],
              },
              output: { presence: 'none' },
            },
          ],
        }),
      'DUPLICATE_IDENTIFIER',
    );
    for (const invalid of [
      'https://contracts.example.org/latest',
      'https://contracts.example.org/domain',
      'urn:example:latest:1',
    ])
      rejected(
        () =>
          parseCatalog({
            contracts: [{ id: invalid, input: { presence: 'none' }, output: { presence: 'none' } }],
          }),
        'INVALID_IDENTIFIER',
      );
    rejected(
      () =>
        parseCatalog({
          contracts: [
            {
              id,
              supersedes: ['https://example.org/latest'],
              input: { presence: 'none' },
              output: { presence: 'none' },
            },
          ],
        }),
      'INVALID_IDENTIFIER',
    );
    expect(
      parseCatalog({
        contracts: [
          { id, supersedes: [otherId], input: { presence: 'none' }, output: { presence: 'none' } },
        ],
      }).contracts[0]!.supersedes,
    ).toEqual([otherId]);
    const parsed = catalog();
    const missing = rejected(
      () => parsed.getContract(otherId, 'remote'),
      'CONTRACT_NOT_FOUND',
      'remote',
    );
    expect(missing.detail).toBeUndefined();
    const outputMissing = rejected(
      () => parsed.select(otherId, 'output', 'json', 'remote'),
      'CONTRACT_NOT_FOUND',
    );
    expect(outputMissing.detail).toEqual({
      code: 'CONTRACT_NOT_FOUND',
      contractId: otherId,
      direction: 'output',
    });
    rejected(() => parsed.select(id, 'input', 'unknown'), 'REPRESENTATION_NOT_SUPPORTED');
    rejected(() => parsed.select(id, 'wrong' as Direction, 'json'), 'INVALID_STRUCTURE');
    rejected(() => parsed.capabilities(id, 'wrong' as Direction), 'INVALID_STRUCTURE');
    expect(parsed.capabilities(id, 'input')[0]!.supported).toBe(true);
  });
  test('schema capability failures precede instance validation', () => {
    for (const [descriptor, code] of [
      [
        { uri: 'https://schemas.example.org/1', mediaType: 'application/schema+json' },
        'SCHEMA_UNAVAILABLE',
      ],
      [
        {
          bundle: { uri: 'https://schemas.example.org/1.zip', mediaType: 'application/zip' },
          entrypoint: 'root.json',
          mediaType: 'application/schema+json',
        },
        'SCHEMA_UNAVAILABLE',
      ],
      [{ inline: {}, mediaType: 'application/schema+json' }, 'UNSUPPORTED_DIALECT'],
      [
        {
          inline: {},
          mediaType: 'application/schema+json',
          dialect: 'https://json-schema.org/draft-07/schema',
        },
        'UNSUPPORTED_DIALECT',
      ],
      [
        { inline: {}, mediaType: 'text/plain', dialect: JSON_SCHEMA_DIALECT },
        'UNSUPPORTED_MEDIA_TYPE',
      ],
    ] as const) {
      const parsed = parseCatalog({
        contracts: [
          {
            id,
            input: {
              presence: 'required',
              representations: [{ id: 'json', mediaType: 'application/json', schema: descriptor }],
            },
            output: { presence: 'none' },
          },
        ],
      });
      rejected(() => parsed.select(id, 'input', 'json'), code);
      expect(parsed.capabilities(id, 'input')[0]!.diagnostic).toBe(code);
    }
  });
});

describe('bounded immutable JSON values', () => {
  test.each([null, false, true, 0, -0, 1.25, '😀', '', {}, [], { nested: [null, 1] }])(
    'preserves %j and caller ownership',
    (value) => {
      const validated = catalog(true).select(id, 'input', 'json').validate(value);
      expect(validated).toEqual(value);
      if (value !== null && typeof value === 'object') {
        expect(validated).not.toBe(value);
        expect(Object.isFrozen(validated)).toBe(true);
        expect(Object.isFrozen(value)).toBe(false);
      }
    },
  );
  test.each([
    undefined,
    1n,
    () => 1,
    Symbol('secret'),
    new Date(),
    new Map(),
    new Set(),
    /x/,
    new Number(1),
    '\ud800',
    '\udc00',
  ])(
    'rejects non-JSON %s',
    (value) => void rejected(() => snapshot(value, context), 'NON_JSON_VALUE'),
  );
  test.each([Infinity, -Infinity, NaN, 9007199254740992, -9007199254740992])(
    'rejects numeric %s',
    (value) => void rejected(() => snapshot(value, context), 'UNSUPPORTED_NUMBER'),
  );
  test('rejects descriptors, symbols, cycles and sparse or augmented arrays without getter execution', () => {
    let reads = 0;
    rejected(
      () =>
        snapshot(
          {
            get secret() {
              reads++;
              return 'secret';
            },
          },
          context,
        ),
      'NON_JSON_VALUE',
    );
    expect(reads).toBe(0);
    rejected(() => snapshot({ [Symbol('private')]: true }, context), 'NON_JSON_VALUE');
    rejected(
      () => snapshot(Object.defineProperty({}, 'private', { value: true }), context),
      'NON_JSON_VALUE',
    );
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    rejected(() => snapshot(cyclic, context), 'NON_JSON_VALUE');
    rejected(() => snapshot(new Array(3), context), 'NON_JSON_VALUE');
    rejected(() => snapshot(Object.assign([], { extra: true }), context), 'NON_JSON_VALUE');
    rejected(() => snapshot(Object.assign([], { '01': true }), context), 'NON_JSON_VALUE');
    rejected(() => snapshot(Object.setPrototypeOf([], null), context), 'NON_JSON_VALUE');
    rejected(
      () =>
        snapshot(
          new Proxy(
            {},
            {
              ownKeys() {
                throw new Error('trap');
              },
            },
          ),
          context,
        ),
      'NON_JSON_VALUE',
    );
    const shared = { x: true };
    expect(snapshot([shared, shared], context)).toEqual([shared, shared]);
    expect(snapshot(Object.assign(Object.create(null) as object, { ok: true }), context)).toEqual({
      ok: true,
    });
    expect(
      Object.getOwnPropertyDescriptor(
        snapshot(JSON.parse('{"__proto__":{"polluted":true}}') as unknown, context),
        '__proto__',
      )?.value,
    ).toEqual({ polluted: true });
  });
  test('limits nodes, depth, keys, Unicode strings and aggregate bytes', () => {
    rejected(
      () =>
        snapshot(
          Array.from({ length: LIMITS.nodes }, () => true),
          context,
        ),
      'RESOURCE_LIMIT',
    );
    rejected(
      () =>
        snapshot(
          Object.fromEntries(Array.from({ length: LIMITS.nodes + 1 }, (_, i) => [String(i), true])),
          context,
        ),
      'RESOURCE_LIMIT',
    );
    let deep: unknown = false;
    for (let i = 0; i <= LIMITS.depth; i++) deep = [deep];
    rejected(() => snapshot(deep, context), 'RESOURCE_LIMIT');
    rejected(() => snapshot('😀'.repeat(LIMITS.string + 1), context), 'RESOURCE_LIMIT');
    expect(snapshot('😀'.repeat(LIMITS.string), context)).toHaveLength(LIMITS.string * 2);
    rejected(
      () =>
        snapshot(
          Array.from({ length: 34 }, () => 'x'.repeat(LIMITS.string)),
          context,
        ),
      'RESOURCE_LIMIT',
    );
    // Exceed bytes only on the last primitive, exercising the final budget check.
    rejected(
      () =>
        snapshot(
          Array.from({ length: 32 }, () => 'x'.repeat(LIMITS.string)),
          context,
        ),
      'RESOURCE_LIMIT',
    );
  });
  test('URI checks reject local misuse and embedded credentials', () => {
    expect(absoluteUri(undefined as unknown as string)).toBe(false);
    expect(absoluteUri('https://user@example.org/v1')).toBe(false);
    expect(absoluteUri('https://:password@example.org/v1')).toBe(false);
  });
  test.each(['urn:example:1', 'https://example.org/v1', 'mailto:a@example.org'])(
    'absolute URI %s',
    (value) => expect(absoluteUri(value)).toBe(true),
  );
  test.each([
    'relative',
    'https://exa mple.org/1',
    'https://[bad]/1',
    'https://example.org/%zz',
    'https://example.org/é',
  ])('invalid URI %s', (value) => expect(absoluteUri(value)).toBe(false));
});

describe('JSON Schema profile', () => {
  test.each(['properties', 'patternProperties'])(
    'rejects Ajv-ignored __proto__ key in %s',
    (keyword) => {
      const schema = JSON.parse(
        `{"type":"object","${keyword}":{"__proto__":{"type":"integer"}}}`,
      ) as unknown;
      rejected(() => catalog(schema).select(id, 'input', 'json'), 'UNSUPPORTED_KEYWORD');
    },
  );
  test('special property names retain complete instance validation', () => {
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const selected = catalog({
        type: 'object',
        patternProperties: { [`^${name}$`]: { type: 'integer' } },
        additionalProperties: false,
      }).select(id, 'input', 'json');
      expect(selected.validate(JSON.parse(`{"${name}":1}`) as unknown)).toEqual(
        JSON.parse(`{"${name}":1}`) as unknown,
      );
      rejected(
        () => selected.validate(JSON.parse(`{"${name}":"invalid"}`) as unknown),
        'INSTANCE_INVALID',
      );
    }
  });
  test('schemas and instances are validated without defaults, coercion, removal or caller mutation', () => {
    const schema = {
      type: 'object',
      properties: { age: { type: 'integer', default: 21 } },
      required: ['age'],
      additionalProperties: false,
    };
    const parsed = catalog(schema);
    schema.properties.age.type = 'string';
    const selected = parsed.select(id, 'input', 'json');
    for (const value of [{}, { age: '21' }, { age: 21, extra: 'secret' }]) {
      const before = structuredClone(value);
      rejected(() => selected.validate(value), 'INSTANCE_INVALID');
      expect(value).toEqual(before);
    }
    const value = Object.freeze({ age: 21 });
    expect(selected.validate(value)).toEqual(value);
    const returnedSchema = selected.representation.schema!.inline as {
      properties: { age: { type: string } };
    };
    expect(returnedSchema.properties.age.type).toBe('integer');
    expect(() => {
      returnedSchema.properties.age.type = 'string';
    }).toThrow(TypeError);
    expect(
      catalog({ default: { arbitrary: true }, examples: [{ arbitrary: true }] })
        .select(id, 'input', 'json')
        .validate({}),
    ).toEqual({});
  });
  test('Boolean, annotation, applicator, unevaluated, numeric and Unicode semantics', () => {
    rejected(() => catalog(false).select(id, 'input', 'json').validate({}), 'INSTANCE_INVALID');
    expect(
      catalog({
        type: 'string',
        format: 'unknown',
        contentEncoding: 'base64',
        contentMediaType: 'image/png',
        contentSchema: false,
      })
        .select(id, 'input', 'json')
        .validate('invalid base64'),
    ).toBe('invalid base64');
    expect(
      catalog({ type: 'string', format: 'email' })
        .select(id, 'input', 'json')
        .validate('not-email'),
    ).toBe('not-email');
    const unicode = catalog({ type: 'string', minLength: 1, maxLength: 1 }).select(
      id,
      'input',
      'json',
    );
    expect(unicode.validate('😀')).toBe('😀');
    rejected(() => unicode.validate('😀😀'), 'INSTANCE_INVALID');
    const composed = catalog({
      type: 'object',
      allOf: [{ properties: { n: { type: 'integer', multipleOf: 2 } }, required: ['n'] }],
      unevaluatedProperties: false,
    }).select(id, 'input', 'json');
    expect(composed.validate({ n: 4 })).toEqual({ n: 4 });
    rejected(() => composed.validate({ n: 3 }), 'INSTANCE_INVALID');
    rejected(() => composed.validate({ n: 4, extra: true }), 'INSTANCE_INVALID');
    expect(
      catalog({ type: 'array', prefixItems: [{ type: 'integer' }], items: false })
        .select(id, 'input', 'json')
        .validate([1]),
    ).toEqual([1]);
    rejected(
      () => catalog({ type: 'integer' }).select(id, 'input', 'json').validate(true),
      'INSTANCE_INVALID',
    );
    expect(
      catalog({ anyOf: [false, { const: null }] })
        .select(id, 'input', 'json')
        .validate(null),
    ).toBe(null);
    expect(
      catalog({
        $schema: JSON_SCHEMA_DIALECT,
        $id: 'https://schemas.example.org/v1',
        if: { type: 'string' },
        then: { minLength: 1 },
        else: { type: 'number' },
      })
        .select(id, 'input', 'json')
        .validate(1),
    ).toBe(1);
  });
  test('native local pointers, anchors, embedded resources, recursive and dynamic references', () => {
    const local = catalog({
      $defs: { positive: { type: 'integer', minimum: 1 } },
      $ref: '#/$defs/positive',
    }).select(id, 'input', 'json');
    expect(local.validate(1)).toBe(1);
    rejected(() => local.validate(0), 'INSTANCE_INVALID');
    expect(
      catalog({ $defs: { child: { $anchor: 'child', const: 1 } }, $ref: '#child' })
        .select(id, 'input', 'json')
        .validate(1),
    ).toBe(1);
    expect(
      catalog({
        $id: 'https://schemas.example.org/root/1',
        $defs: { child: { $id: 'child', const: 1 } },
        $ref: 'child',
      })
        .select(id, 'input', 'json')
        .validate(1),
    ).toBe(1);
    for (const schema of [
      {
        type: 'object',
        properties: { child: { $ref: '#' }, value: { type: 'integer' } },
        additionalProperties: false,
      },
      {
        $dynamicAnchor: 'node',
        type: 'object',
        properties: { child: { $dynamicRef: '#node' } },
        additionalProperties: false,
      },
    ])
      expect(
        catalog(schema)
          .select(id, 'input', 'json')
          .validate({ child: { child: {} } }),
      ).toEqual({ child: { child: {} } });
    rejected(
      () => catalog({ $ref: 'https://private.example.org/secret' }).select(id, 'input', 'json'),
      'SCHEMA_UNAVAILABLE',
    );
    rejected(
      () => catalog({ $ref: '#/missing' }).select(id, 'input', 'json'),
      'SCHEMA_UNAVAILABLE',
    );
    rejected(() => catalog({ $ref: '#' }).select(id, 'input', 'json'), 'SCHEMA_INVALID');
    rejected(
      () =>
        catalog({ $dynamicRef: 'https://private.example.org/schema#node' }).select(
          id,
          'input',
          'json',
        ),
      'SCHEMA_UNAVAILABLE',
    );
    const recursive = catalog({ $ref: '#', type: 'object' }).select(id, 'input', 'json');
    rejected(() => recursive.validate({}), 'RESOURCE_LIMIT');
  });
  test.each([
    [null, 'SCHEMA_INVALID'],
    [[], 'SCHEMA_INVALID'],
    [1, 'SCHEMA_INVALID'],
    [{ type: 'unknown' }, 'SCHEMA_INVALID'],
    [{ minLength: -1 }, 'SCHEMA_INVALID'],
    [{ $schema: 'https://example.org/dialect' }, 'UNSUPPORTED_DIALECT'],
    [{ $id: 'bad id' }, 'SCHEMA_INVALID'],
    [{ $id: 1 }, 'SCHEMA_INVALID'],
    [{ unknownAssertion: true }, 'UNSUPPORTED_KEYWORD'],
    [{ $async: true }, 'UNSUPPORTED_KEYWORD'],
    [{ multipleOf: 0.1 }, 'UNSUPPORTED_NUMBER'],
    [{ multipleOf: 0 }, 'UNSUPPORTED_NUMBER'],
    [{ multipleOf: 'two' }, 'UNSUPPORTED_NUMBER'],
    [{ properties: [] }, 'SCHEMA_INVALID'],
    [{ items: null }, 'SCHEMA_INVALID'],
    [{ allOf: {} }, 'SCHEMA_INVALID'],
    [{ $vocabulary: [] }, 'SCHEMA_INVALID'],
    [{ $vocabulary: { relative: true } }, 'SCHEMA_INVALID'],
    [{ $vocabulary: { 'https://example.org/vocab': 'yes' } }, 'SCHEMA_INVALID'],
    [{ $vocabulary: { 'https://example.org/vocab': true } }, 'UNSUPPORTED_VOCABULARY'],
    [
      { $vocabulary: { 'https://json-schema.org/draft/2020-12/vocab/format-assertion': true } },
      'UNSUPPORTED_VOCABULARY',
    ],
    [
      { $vocabulary: { 'https://json-schema.org/draft/2020-12/vocab/validation': false } },
      'UNSUPPORTED_VOCABULARY',
    ],
  ] as const)(
    'rejects schema %j as %s',
    (schema, code) => void rejected(() => catalog(schema).select(id, 'input', 'json'), code),
  );
  test('optional unfamiliar vocabularies do not enable new assertions', () => {
    expect(
      catalog({
        $vocabulary: {
          'https://example.org/vocab': false,
          'https://json-schema.org/draft/2020-12/vocab/core': true,
        },
        type: 'boolean',
      })
        .select(id, 'input', 'json')
        .validate(true),
    ).toBe(true);
    rejected(
      () =>
        catalog({ $vocabulary: { 'https://example.org/vocab': false }, custom: true }).select(
          id,
          'input',
          'json',
        ),
      'UNSUPPORTED_KEYWORD',
    );
    rejected(
      () => catalog({ const: 9007199254740992 }).select(id, 'input', 'json'),
      'UNSUPPORTED_NUMBER',
    );
  });
  test('bounds schema-node and reference graph sizes before compilation', () => {
    rejected(
      () =>
        catalog({
          $defs: Object.fromEntries(
            Array.from({ length: LIMITS.schemas }, (_, i) => [String(i), true]),
          ),
        }).select(id, 'input', 'json'),
      'RESOURCE_LIMIT',
    );
    rejected(
      () =>
        catalog({
          $defs: { v: true },
          allOf: Array.from({ length: LIMITS.references + 1 }, () => ({ $ref: '#/$defs/v' })),
        }).select(id, 'input', 'json'),
      'RESOURCE_LIMIT',
    );
    const throws = (() => {
      throw new Error('private');
    }) as unknown as ValidateFunction;
    rejected(() => checkInstance(throws, {}, context), 'RESOURCE_LIMIT');
  });
  test.each([
    '',
    'abc',
    '^abc$',
    '^[A-Za-z0-9._-]{1,128}$',
    '^a?$',
    '^a*$',
    '^a+$',
    '^a{2}$',
    '^a{2,}$',
    '^a{2,2}$',
    '^a{2,3}$',
    '^\\.$',
    '^[^a]$',
  ])(
    'accepts portable pattern %s',
    (pattern) => void catalog({ pattern }).select(id, 'input', 'json'),
  );
  test.each([
    'a'.repeat(129),
    'é',
    '(a+)+$',
    'a|b',
    '\\d',
    '\\p{L}',
    '\\1',
    '.',
    'a^',
    '$a',
    '[abc',
    '[]',
    '[^]',
    '[a\\d]',
    '[[a]',
    '\\',
    '*a',
    'a**',
    'a+a+',
    'a{}',
    'a{9000}',
    'a{2,1}',
    'a{1,9000}',
    '[z-a]',
    'a\\-b',
    ']',
    '}',
    'a{1,2}?',
  ])(
    'rejects pattern %s',
    (pattern) =>
      void rejected(() => catalog({ pattern }).select(id, 'input', 'json'), 'UNSUPPORTED_REGEX'),
  );
  test('patternProperties uses the same profile and checks the entire instance', () => {
    const selected = catalog({
      type: 'object',
      patternProperties: { '^a+$': { type: 'number' } },
      additionalProperties: false,
    }).select(id, 'input', 'json');
    expect(selected.validate({ aa: 1 })).toEqual({ aa: 1 });
    rejected(() => selected.validate({ aa: 'one' }), 'INSTANCE_INVALID');
    rejected(
      () => catalog({ patternProperties: { '(a+)': true } }).select(id, 'input', 'json'),
      'UNSUPPORTED_REGEX',
    );
  });
});

describe('primary selection, carriers, metadata and presence', () => {
  test.each(['required', 'optional', 'none'])(
    'presence %s is independent in both directions',
    (presence) => {
      const parsed = catalog(undefined, presence, presence);
      for (const direction of ['input', 'output'] as const) {
        const absent = direction === 'input' ? [companion] : [];
        if (presence === 'required')
          rejected(
            () => decodePrimary(parsed, id, direction, absent),
            'PAYLOAD_PRESENCE_VIOLATION',
          );
        else expect(decodePrimary(parsed, id, direction, absent)).toEqual({ present: false });
        if (presence === 'none')
          rejected(
            () => decodePrimary(parsed, id, direction, [primary({}, direction)], 'json'),
            'PAYLOAD_PRESENCE_VIOLATION',
          );
        else {
          expect(
            decodePrimary(
              parsed,
              id,
              direction,
              [
                primary({}, direction),
                { data: { unselected: true }, mediaType: 'application/json' },
              ],
              'json',
            ),
          ).toMatchObject({ present: true, value: {} });
          rejected(
            () =>
              decodePrimary(
                parsed,
                id,
                direction,
                [primary({}, direction), primary({}, direction)],
                'json',
              ),
            'PAYLOAD_PRESENCE_VIOLATION',
          );
        }
      }
    },
  );
  test.each([null, {}, [], '', false, 0])('root value %j is present in core', (value) => {
    const parsed = catalog();
    const part = encodePrimary(parsed.select(id, 'input', 'json'), value);
    expect(decodePrimary(parsed, id, 'input', [part], 'json')).toMatchObject({
      present: true,
      value,
    });
  });
  test('official codec rejects root null and preserves nested null without wrapping', () => {
    const parsed = catalog();
    const selected = parsed.select(id, 'input', 'json');
    rejected(() => encodePrimary(selected, null, 'a2a-js-1.3.0'), 'UNSUPPORTED_CARRIER', 'local');
    rejected(
      () => decodePrimary(parsed, id, 'input', [primary(null)], 'json', 'a2a-js-1.3.0'),
      'UNSUPPORTED_CARRIER',
      'remote',
    );
    expect(
      decodePrimary(
        parsed,
        id,
        'input',
        [encodePrimary(selected, { nested: null }, 'a2a-js-1.3.0')],
        'json',
        'a2a-js-1.3.0',
      ),
    ).toMatchObject({ value: { nested: null } });
  });
  test('text carrier preserves empty strings and parameter identity', () => {
    const parsed = catalog(
      { type: 'string' },
      'required',
      'required',
      'Text/Plain; Charset="UTF-8"',
    );
    const selected = parsed.select(id, 'input', 'json');
    const part = encodePrimary(selected, '');
    expect(part).toHaveProperty('text', '');
    expect(decodePrimary(parsed, id, 'input', [part], 'json')).toMatchObject({ value: '' });
    rejected(() => selected.validate({}), 'INVALID_CARRIER');
    expect(matchMediaTypes('Text/Plain; Charset="UTF-8"', 'text/plain')).toBe(true);
    expect(matchMediaTypes('APPLICATION/JSON', 'application/json')).toBe(true);
    expect(matchMediaTypes('text/plain', 'application/json')).toBe(false);
    expect(matchMediaTypes('application/json\n', 'application/json')).toBe(false);
    expect(matchMediaTypes(undefined as unknown as string, 'application/json')).toBe(false);
    expect(matchMediaTypes('application/json', 'text/plain; charset=iso-8859-1')).toBe(false);
  });
  test.each([
    'application/vnd.example+json',
    'application/json; charset=utf-8',
    'text/plain; charset=utf-16',
    'text/plain; charset=utf-8; charset=utf-8',
    'text/plain; q=1',
    '*/*',
    'application/*',
    'text/plain; charset=UTF-8; unknown=x',
  ])('media %s is explicitly unsupported', (mediaType) => {
    const parsed = catalog(undefined, 'required', 'required', mediaType);
    rejected(() => parsed.select(id, 'input', 'json'), 'UNSUPPORTED_MEDIA_TYPE');
    expect(matchMediaTypes(mediaType, 'application/json')).toBe(false);
  });
  test.each([
    null,
    {},
    { text: 4 },
    { text: '', data: {} },
    { raw: 1 },
    { raw: 'bad base64' },
    { url: 1 },
    { url: 'relative' },
    { text: 'ok', mediaType: 1 },
    { text: 'ok', filename: false },
  ])(
    'carrier %j is rejected before selection',
    (part) =>
      void rejected(() => decodePrimary(catalog(), id, 'input', [part], 'json'), 'INVALID_CARRIER'),
  );
  test('companion files remain outside payload validation; no content-less or empty input carriers', () => {
    expect(
      decodePrimary(catalog(undefined, 'none'), id, 'input', [
        { raw: '' },
        { raw: 'eA==' },
        { raw: 'eHg=' },
        { raw: 'eHh4' },
        { url: 'https://example.org/file' },
      ]),
    ).toEqual({ present: false });
    rejected(() => decodePrimary(catalog(), id, 'input', []), 'INVALID_CARRIER');
    rejected(() => decodePrimary(catalog(), id, 'input', {}), 'INVALID_CARRIER');
    rejected(
      () =>
        decodePrimary(
          catalog(),
          id,
          'input',
          Array.from({ length: LIMITS.parts + 1 }, () => companion),
        ),
      'RESOURCE_LIMIT',
    );
    rejected(() => decodePrimary(catalog(), id, 'wrong' as Direction, []), 'INVALID_STRUCTURE');
    expect(
      decodePrimary(catalog(undefined, 'optional'), id, 'input', [
        { text: 'ok', metadata: { other: true } },
      ]),
    ).toEqual({ present: false });
  });
  test('malformed, mismatched and missing primary identity is never inferred from media', () => {
    const parsed = catalog();
    for (const part of [
      { data: {}, metadata: 1 },
      { data: {}, metadata: metadata({}) },
      {
        data: {},
        metadata: metadata({
          contractId: id,
          direction: 'input',
          representationId: 'json',
          role: 'companion',
        }),
      },
    ])
      rejected(() => decodePrimary(parsed, id, 'input', [part], 'json'), 'INVALID_METADATA');
    rejected(
      () =>
        decodePrimary(
          parsed,
          id,
          'input',
          [
            {
              data: {},
              metadata: metadata({
                contractId: otherId,
                direction: 'input',
                representationId: 'json',
                role: 'primary',
              }),
            },
          ],
          'json',
        ),
      'PRIMARY_IDENTITY_MISMATCH',
    );
    rejected(
      () => decodePrimary(parsed, id, 'input', [primary({}, 'output')], 'json'),
      'PRIMARY_IDENTITY_MISMATCH',
    );
    rejected(() => decodePrimary(parsed, id, 'input', [primary()]), 'PRIMARY_IDENTITY_MISMATCH');
    rejected(
      () => decodePrimary(parsed, id, 'input', [primary()], 'wrong'),
      'PRIMARY_IDENTITY_MISMATCH',
    );
    rejected(
      () => decodePrimary(parsed, id, 'input', [primary({}, 'input', 'unknown')], 'unknown'),
      'REPRESENTATION_NOT_SUPPORTED',
    );
    rejected(
      () => decodePrimary(catalog(undefined, 'optional'), id, 'input', [companion], 'json'),
      'INVALID_METADATA',
    );
    for (const mediaType of [undefined, 'text/plain', 'application/json; q=1']) {
      const part = primary() as Record<string, unknown>;
      if (mediaType === undefined) delete part.mediaType;
      else part.mediaType = mediaType;
      rejected(
        () => decodePrimary(parsed, id, 'input', [part], 'json'),
        'REPRESENTATION_NOT_SUPPORTED',
      );
    }
    const part = primary() as Record<string, unknown>;
    delete part.data;
    part.text = '{}';
    rejected(() => decodePrimary(parsed, id, 'input', [part], 'json'), 'UNSUPPORTED_CARRIER');
  });
  test('invocation enforces direction-specific selection and known output IDs', () => {
    const parsed = catalog();
    expect(
      validateInvocation(
        parsed,
        metadata({
          contractId: id,
          inputRepresentationId: 'json',
          acceptedOutputRepresentationIds: ['json'],
        }),
        [primary()],
      ),
    ).toMatchObject({ input: { present: true } });
    expect(
      validateInvocation(catalog(undefined, 'none', 'none'), metadata({ contractId: id }), [
        companion,
      ]),
    ).toMatchObject({ input: { present: false } });
    for (const value of [
      null,
      {},
      metadata({}),
      metadata({ contractId: id, unknown: true }),
      metadata({ contractId: id, acceptedOutputRepresentationIds: [] }),
      metadata({ contractId: id, acceptedOutputRepresentationIds: ['json', 'json'] }),
    ])
      rejected(() => validateInvocation(parsed, value, [primary()]), 'INVALID_METADATA');
    rejected(
      () =>
        validateInvocation(
          parsed,
          metadata({
            contractId: id,
            inputRepresentationId: 'json',
            acceptedOutputRepresentationIds: ['unknown'],
          }),
          [primary()],
        ),
      'REPRESENTATION_NOT_SUPPORTED',
    );
    rejected(
      () =>
        validateInvocation(
          catalog(undefined, 'none', 'none'),
          metadata({ contractId: id, acceptedOutputRepresentationIds: ['json'] }),
          [companion],
        ),
      'INVALID_METADATA',
    );
    rejected(
      () => validateInvocation(parsed, metadata({ contractId: id }), [primary()]),
      'PRIMARY_IDENTITY_MISMATCH',
    );
    rejected(
      () =>
        validateInvocation(
          catalog(undefined, 'none'),
          metadata({ contractId: id, inputRepresentationId: 'json' }),
          [companion],
        ),
      'INVALID_METADATA',
    );
    const noInput = validateInvocation(
      catalog(undefined, 'optional'),
      metadata({ contractId: id }),
      [companion],
    );
    expect(Object.isFrozen(noInput.invocation)).toBe(true);
  });
  test('result echo binds presence, identity and the complete output', () => {
    const parsed = catalog();
    expect(
      validateResult(
        parsed,
        id,
        metadata({ contractId: id, outputRepresentationId: 'json' }),
        [primary({}, 'output')],
        'json',
      ),
    ).toMatchObject({ present: true });
    expect(
      validateResult(catalog(undefined, 'none', 'none'), id, metadata({ contractId: id }), []),
    ).toEqual({ present: false });
    expect(
      validateResult(
        catalog(undefined, 'none', 'optional'),
        id,
        metadata({ contractId: id }),
        [],
        'json',
      ),
    ).toEqual({ present: false });
    rejected(
      () => validateResult(parsed, id, metadata({ contractId: otherId }), []),
      'PRIMARY_IDENTITY_MISMATCH',
    );
    rejected(
      () =>
        validateResult(
          parsed,
          id,
          metadata({ contractId: id, outputRepresentationId: 'json' }),
          [primary({}, 'output')],
          'wrong',
        ),
      'PRIMARY_IDENTITY_MISMATCH',
    );
    rejected(
      () => validateResult(parsed, id, metadata({ contractId: id }), [primary({}, 'output')]),
      'PRIMARY_IDENTITY_MISMATCH',
    );
    rejected(
      () =>
        validateResult(
          catalog(undefined, 'none', 'none'),
          id,
          metadata({ contractId: id, outputRepresentationId: 'json' }),
          [],
        ),
      'INVALID_METADATA',
    );
    rejected(
      () =>
        validateResult(parsed, id, metadata({ contractId: id, inputRepresentationId: 'json' }), []),
      'INVALID_METADATA',
    );
    rejected(
      () =>
        validateResult(
          catalog({ type: 'integer' }),
          id,
          metadata({ contractId: id, outputRepresentationId: 'json' }),
          [primary('wrong', 'output')],
        ),
      'INSTANCE_INVALID',
      'remote',
    );
  });
});

test('errors contain only stable sanitized diagnostics and valid pinned draft detail', () => {
  const error = rejected(
    () => catalog({ type: 'integer' }).select(id, 'input', 'json').validate('CREDENTIAL-SECRET'),
    'INSTANCE_INVALID',
    'local',
  );
  const serialized = JSON.stringify(error);
  expect(serialized).not.toContain('CREDENTIAL');
  expect(error.message).toBe('Schema Contract rejected: INSTANCE_INVALID.');
  expect(error.cause).toBeUndefined();
  checkStructure('error-detail', snapshot(error.detail, context), context);
  for (const code of [
    'CONTRACT_NOT_FOUND',
    'SCHEMA_UNAVAILABLE',
    'PAYLOAD_PRESENCE_VIOLATION',
    'INSTANCE_INVALID',
    'REPRESENTATION_NOT_SUPPORTED',
    'UNSUPPORTED_MEDIA_TYPE',
    'UNSUPPORTED_CARRIER',
    'SCHEMA_INVALID',
    'UNSUPPORTED_DIALECT',
    'UNSUPPORTED_VOCABULARY',
    'UNSUPPORTED_KEYWORD',
    'UNSUPPORTED_REGEX',
    'UNSUPPORTED_NUMBER',
    'INVALID_METADATA',
  ] as const) {
    const failure = new ContractError(code, {
      origin: 'remote',
      contractId: id,
      direction: 'output',
    });
    checkStructure('error-detail', snapshot(failure.detail, context), context);
    expect(Object.isFrozen(failure.detail)).toBe(true);
  }
  expect(new ContractError('INVALID_STRUCTURE', context).detail).toBeUndefined();
  expect(
    new ContractError('INVALID_STRUCTURE', { origin: 'local', contractId: id }).detail,
  ).toBeUndefined();
});
