/** Pinned draft namespace. Package versions must never replace this identifier. */
export const EXTENSION_URI = 'https://w3id.org/a2a-schema-contract/draft/0.1' as const;
export const A2A_PROTOCOL_VERSION = '1.0' as const;
export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema' as const;

/** JSON data; discovery boundaries still accept unknown until runtime validation exists. */
export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type Presence = 'required' | 'optional' | 'none';
export type Direction = 'input' | 'output';

export const SCHEMA_NAMES = [
  'catalog',
  'common',
  'error-detail',
  'extension-params',
  'invocation-metadata',
  'part-metadata',
  'result-metadata',
] as const;
export type ExtensionSchemaName = (typeof SCHEMA_NAMES)[number];

/** Returns an installed resource URL. Reading it is an explicit caller operation. */
export function getSchemaResource(name: ExtensionSchemaName): URL {
  if (!SCHEMA_NAMES.includes(name)) {
    throw new TypeError('Unknown extension schema resource.');
  }
  return new URL(`../resources/schema/${name}.schema.json`, import.meta.url);
}
