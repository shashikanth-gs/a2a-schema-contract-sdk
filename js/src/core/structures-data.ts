/* Generated from the verified contract snapshot; do not edit. */
export const structures: readonly object[] = [
  {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://w3id.org/a2a-schema-contract/schema/draft/0.1/catalog.schema.json',
    title: 'A2A Schema Contract catalog',
    type: 'object',
    additionalProperties: false,
    required: ['contracts'],
    properties: {
      contracts: { type: 'array', minItems: 1, items: { $ref: '#/$defs/contract' } },
    },
    $defs: {
      contract: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'input', 'output'],
        properties: {
          id: {
            $ref: 'https://w3id.org/a2a-schema-contract/schema/draft/0.1/common.schema.json#/$defs/absoluteUri',
          },
          description: { type: 'string' },
          skillIds: {
            type: 'array',
            uniqueItems: true,
            items: { type: 'string', minLength: 1 },
          },
          supersedes: {
            type: 'array',
            uniqueItems: true,
            items: {
              $ref: 'https://w3id.org/a2a-schema-contract/schema/draft/0.1/common.schema.json#/$defs/absoluteUri',
            },
          },
          input: { $ref: '#/$defs/direction' },
          output: { $ref: '#/$defs/direction' },
        },
      },
      direction: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['presence'],
            properties: { presence: { const: 'none' } },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['presence', 'representations'],
            properties: {
              presence: { enum: ['required', 'optional'] },
              representations: {
                type: 'array',
                minItems: 1,
                items: { $ref: '#/$defs/representation' },
              },
            },
          },
        ],
      },
      representation: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'mediaType'],
        properties: {
          id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
          mediaType: {
            $ref: 'https://w3id.org/a2a-schema-contract/schema/draft/0.1/common.schema.json#/$defs/mediaType',
          },
          description: { type: 'string' },
          schema: { $ref: '#/$defs/schemaDescriptor' },
        },
      },
      schemaDescriptor: {
        oneOf: [
          { $ref: '#/$defs/inlineSchema' },
          { $ref: '#/$defs/externalSchema' },
          { $ref: '#/$defs/bundledSchema' },
        ],
      },
      schemaBase: {
        type: 'object',
        properties: {
          mediaType: {
            $ref: 'https://w3id.org/a2a-schema-contract/schema/draft/0.1/common.schema.json#/$defs/mediaType',
          },
          dialect: {
            $ref: 'https://w3id.org/a2a-schema-contract/schema/draft/0.1/common.schema.json#/$defs/absoluteUri',
          },
        },
      },
      inlineSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['inline', 'mediaType'],
        properties: {
          inline: true,
          mediaType: {
            $ref: 'https://w3id.org/a2a-schema-contract/schema/draft/0.1/common.schema.json#/$defs/mediaType',
          },
          dialect: {
            $ref: 'https://w3id.org/a2a-schema-contract/schema/draft/0.1/common.schema.json#/$defs/absoluteUri',
          },
        },
      },
      externalSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['uri', 'mediaType'],
        properties: {
          uri: {
            $ref: 'https://w3id.org/a2a-schema-contract/schema/draft/0.1/common.schema.json#/$defs/absoluteUri',
          },
          mediaType: {
            $ref: 'https://w3id.org/a2a-schema-contract/schema/draft/0.1/common.schema.json#/$defs/mediaType',
          },
          dialect: {
            $ref: 'https://w3id.org/a2a-schema-contract/schema/draft/0.1/common.schema.json#/$defs/absoluteUri',
          },
          integrity: {
            $ref: 'https://w3id.org/a2a-schema-contract/schema/draft/0.1/common.schema.json#/$defs/integrity',
          },
        },
      },
      bundledSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['bundle', 'entrypoint', 'mediaType'],
        properties: {
          bundle: {
            type: 'object',
            additionalProperties: false,
            required: ['uri', 'mediaType'],
            properties: {
              uri: {
                $ref: 'https://w3id.org/a2a-schema-contract/schema/draft/0.1/common.schema.json#/$defs/absoluteUri',
              },
              mediaType: {
                $ref: 'https://w3id.org/a2a-schema-contract/schema/draft/0.1/common.schema.json#/$defs/mediaType',
              },
              integrity: {
                $ref: 'https://w3id.org/a2a-schema-contract/schema/draft/0.1/common.schema.json#/$defs/integrity',
              },
            },
          },
          entrypoint: {
            type: 'string',
            minLength: 1,
            pattern: '^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$)).+$',
          },
          mediaType: {
            $ref: 'https://w3id.org/a2a-schema-contract/schema/draft/0.1/common.schema.json#/$defs/mediaType',
          },
          dialect: {
            $ref: 'https://w3id.org/a2a-schema-contract/schema/draft/0.1/common.schema.json#/$defs/absoluteUri',
          },
        },
      },
    },
  },
  {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://w3id.org/a2a-schema-contract/schema/draft/0.1/common.schema.json',
    title: 'A2A Schema Contract common definitions',
    $defs: {
      absoluteUri: { type: 'string', format: 'uri', pattern: '^[A-Za-z][A-Za-z0-9+.-]*:' },
      mediaType: {
        type: 'string',
        minLength: 3,
        pattern:
          "^[!#$%&'*+.^_`|~0-9A-Za-z-]+/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\\s*;\\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|\"[^\"\\r\\n]*\"))*$",
      },
      integrity: {
        type: 'object',
        additionalProperties: false,
        required: ['algorithm', 'value'],
        properties: {
          algorithm: { type: 'string', enum: ['sha-256', 'sha-512'] },
          value: { type: 'string', contentEncoding: 'base64', minLength: 1 },
        },
        allOf: [
          {
            if: {
              properties: { algorithm: { const: 'sha-256' } },
              required: ['algorithm'],
            },
            then: {
              properties: { value: { type: 'string', pattern: '^[A-Za-z0-9+/]{43}=$' } },
            },
          },
          {
            if: {
              properties: { algorithm: { const: 'sha-512' } },
              required: ['algorithm'],
            },
            then: {
              properties: { value: { type: 'string', pattern: '^[A-Za-z0-9+/]{86}==$' } },
            },
          },
        ],
      },
    },
  },
  {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://w3id.org/a2a-schema-contract/schema/draft/0.1/error-detail.schema.json',
    title: 'A2A Schema Contract error detail',
    type: 'object',
    additionalProperties: false,
    required: ['code', 'contractId', 'direction'],
    properties: {
      code: {
        enum: [
          'CONTRACT_NOT_FOUND',
          'AMBIGUOUS_CONTRACT',
          'REPRESENTATION_NOT_SUPPORTED',
          'PAYLOAD_PRESENCE_VIOLATION',
          'SCHEMA_UNAVAILABLE',
          'SCHEMA_INVALID',
          'INSTANCE_INVALID',
          'OUTPUT_CONTRACT_VIOLATION',
          'SCHEMA_INTEGRITY_MISMATCH',
        ],
      },
      contractId: {
        $ref: 'https://w3id.org/a2a-schema-contract/schema/draft/0.1/common.schema.json#/$defs/absoluteUri',
      },
      direction: { enum: ['input', 'output'] },
      representationId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
      instancePath: { type: 'string' },
      schemaLocation: {
        $ref: 'https://w3id.org/a2a-schema-contract/schema/draft/0.1/common.schema.json#/$defs/absoluteUri',
      },
      keyword: { type: 'string' },
      message: { type: 'string' },
    },
  },
  {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://w3id.org/a2a-schema-contract/schema/draft/0.1/extension-params.schema.json',
    title: 'A2A Schema Contract AgentExtension.params',
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['catalog'],
        properties: {
          catalog: {
            type: 'object',
            additionalProperties: false,
            required: ['inline'],
            properties: {
              inline: {
                $ref: 'https://w3id.org/a2a-schema-contract/schema/draft/0.1/catalog.schema.json',
              },
            },
          },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['catalog'],
        properties: {
          catalog: {
            type: 'object',
            additionalProperties: false,
            required: ['uri', 'mediaType'],
            properties: {
              uri: {
                $ref: 'https://w3id.org/a2a-schema-contract/schema/draft/0.1/common.schema.json#/$defs/absoluteUri',
              },
              mediaType: { const: 'application/json' },
              integrity: {
                $ref: 'https://w3id.org/a2a-schema-contract/schema/draft/0.1/common.schema.json#/$defs/integrity',
              },
            },
          },
        },
      },
    ],
  },
  {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://w3id.org/a2a-schema-contract/schema/draft/0.1/invocation-metadata.schema.json',
    title: 'A2A Schema Contract invocation metadata',
    type: 'object',
    additionalProperties: false,
    required: ['contractId'],
    properties: {
      contractId: {
        $ref: 'https://w3id.org/a2a-schema-contract/schema/draft/0.1/common.schema.json#/$defs/absoluteUri',
      },
      inputRepresentationId: {
        type: 'string',
        pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$',
      },
      acceptedOutputRepresentationIds: {
        type: 'array',
        minItems: 1,
        uniqueItems: true,
        items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
      },
    },
  },
  {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://w3id.org/a2a-schema-contract/schema/draft/0.1/part-metadata.schema.json',
    title: 'A2A Schema Contract primary Part metadata',
    type: 'object',
    additionalProperties: false,
    required: ['contractId', 'direction', 'representationId', 'role'],
    properties: {
      contractId: {
        $ref: 'https://w3id.org/a2a-schema-contract/schema/draft/0.1/common.schema.json#/$defs/absoluteUri',
      },
      direction: { enum: ['input', 'output'] },
      representationId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
      role: { const: 'primary' },
    },
  },
  {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://w3id.org/a2a-schema-contract/schema/draft/0.1/result-metadata.schema.json',
    title: 'A2A Schema Contract result metadata',
    type: 'object',
    additionalProperties: false,
    required: ['contractId'],
    properties: {
      contractId: {
        $ref: 'https://w3id.org/a2a-schema-contract/schema/draft/0.1/common.schema.json#/$defs/absoluteUri',
      },
      outputRepresentationId: {
        type: 'string',
        pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$',
      },
    },
  },
];
