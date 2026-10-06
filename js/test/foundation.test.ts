import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { A2A_JS_SDK_VERSION } from '../src/adapters/a2a-js/index.js';
import {
  A2A_PROTOCOL_VERSION,
  EXTENSION_URI,
  getSchemaResource,
  JSON_SCHEMA_DIALECT,
  SCHEMA_NAMES,
  type ExtensionSchemaName,
} from '../src/core/index.js';

describe('published draft identity and resources', () => {
  test('keeps package-independent wire identifiers', () => {
    expect(EXTENSION_URI).toBe('https://w3id.org/a2a-schema-contract/draft/0.1');
    expect(A2A_PROTOCOL_VERSION).toBe('1.0');
    expect(JSON_SCHEMA_DIALECT).toBe('https://json-schema.org/draft/2020-12/schema');
  });
  test('all public module boundaries expose their declared foundation exports', async () => {
    const root = await import('@shashikanth-gs/a2a-schema-contract');
    const core = await import('@shashikanth-gs/a2a-schema-contract/core');
    const client = await import('@shashikanth-gs/a2a-schema-contract/client');
    const server = await import('@shashikanth-gs/a2a-schema-contract/server');
    const adapter = await import('@shashikanth-gs/a2a-schema-contract/adapters/a2a-js');
    expect([
      root.EXTENSION_URI,
      core.EXTENSION_URI,
      client.EXTENSION_URI,
      server.EXTENSION_URI,
    ]).toEqual(Array(4).fill(EXTENSION_URI));
    expect(adapter.A2A_JS_SDK_VERSION).toBe('1.3.0');
    expect(A2A_JS_SDK_VERSION).toBe(adapter.A2A_JS_SDK_VERSION);
  });
  test('installed resources match immutable upstream hashes and namespaces', async () => {
    const core = await import('@shashikanth-gs/a2a-schema-contract/core');
    const manifest = JSON.parse(
      await readFile(new URL('../../vendor/contract/manifest.json', import.meta.url), 'utf8'),
    ) as { files: Record<string, string> };
    expect(SCHEMA_NAMES).toHaveLength(7);
    for (const name of SCHEMA_NAMES) {
      const bytes = await readFile(core.getSchemaResource(name));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(
        manifest.files[`schema/${name}.schema.json`],
      );
      const schema = JSON.parse(bytes.toString('utf8')) as { $id: string; $schema: string };
      expect(schema.$id).toBe(
        `https://w3id.org/a2a-schema-contract/schema/draft/0.1/${name}.schema.json`,
      );
      expect(schema.$schema).toBe(JSON_SCHEMA_DIALECT);
    }
  });
  test('rejects traversal and non-public resources at the JavaScript boundary', () => {
    for (const name of [
      '../../package.json',
      'catalog.schema.json',
      '',
      'constructor',
      undefined,
    ]) {
      expect(() => getSchemaResource(name as ExtensionSchemaName)).toThrow(
        'Unknown extension schema resource.',
      );
    }
  });
  test('resource lookup is pure and performs no retrieval', () => {
    expect(getSchemaResource('catalog').protocol).toBe('file:');
    expect(getSchemaResource('catalog').pathname).toMatch(
      /\/resources\/schema\/catalog.schema.json$/u,
    );
  });
});
