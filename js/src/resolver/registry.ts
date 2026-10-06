import type { AnySchema, ValidateFunction } from 'ajv/dist/2020.js';
import { JSON_SCHEMA_DIALECT, type JsonValue } from '../core/constants.js';
import { fail, type ErrorContext } from '../core/errors.js';
import { isRecord } from '../core/json.js';
import {
  inspectSchema,
  schemaValidator,
  mapSchemas,
  oneSchema,
  arraySchemas,
} from '../core/schema.js';

export interface ResourceDocument {
  readonly value: JsonValue;
  readonly uri: string;
}
export interface GraphLimits {
  readonly documents: number;
  readonly references: number;
  readonly schemas: number;
  readonly referenceDepth: number;
}

/** Native resources stay intact: register documents, then compile refs with Ajv's offline registry. */
export async function prepareSchema(
  root: ResourceDocument,
  entry: string,
  load: (uri: string) => Promise<ResourceDocument>,
  limits: GraphLimits,
  context: ErrorContext,
  checkpoint: () => void,
): Promise<ValidateFunction> {
  const ajv = schemaValidator();
  const resources = new Map<string, JsonValue>();
  const loaded = new Set<string>();
  const visiting = new Set<string>();
  const locations = new Set<string>();
  const targets: string[] = [entry];
  let schemas = 0;
  let references = 0;
  let documents = 0;
  function absolute(value: string, base: string): string {
    try {
      const url = new URL(value, base);
      if (url.username || url.password || /\s|\\|%(?![0-9a-f]{2})/iu.test(value))
        fail('SCHEMA_INVALID', context);
      return url.href;
    } catch {
      return fail('SCHEMA_INVALID', context);
    }
  }
  function withoutFragment(uri: string): string {
    return uri.split('#')[0]!;
  }
  function location(uri: string): string {
    const index = uri.indexOf('#');
    const document = index === -1 ? uri : uri.slice(0, index);
    const fragment = index === -1 ? '' : uri.slice(index + 1);
    try {
      return document + (fragment ? '#' + decodeURIComponent(fragment) : '');
    } catch {
      return fail('SCHEMA_INVALID', context);
    }
  }
  async function add(document: ResourceDocument, requested: string, depth: number): Promise<void> {
    checkpoint();
    if (depth > limits.referenceDepth || ++documents > limits.documents)
      fail('RESOURCE_LIMIT', context);
    inspectSchema(document.value, context);
    const refs: string[] = [];
    const localIds = new Map<string, JsonValue>();
    function walk(node: JsonValue, base: string, pointer: string, resourcePointer: string): void {
      if (++schemas > limits.schemas) fail('RESOURCE_LIMIT', context);
      if (isRecord(node) && typeof node.$id === 'string') {
        base = absolute(node.$id, base);
        if (new URL(base).hash) fail('SCHEMA_INVALID', context);
        const old = localIds.get(base) ?? resources.get(base);
        if (old !== undefined && old !== node) fail('SCHEMA_INVALID', context);
        localIds.set(base, node);
        resourcePointer = pointer;
      }
      locations.add(location(document.uri + '#' + encodeURIComponent(pointer)));
      locations.add(location(requested + '#' + encodeURIComponent(pointer)));
      locations.add(
        location(base + '#' + encodeURIComponent(pointer.slice(resourcePointer.length))),
      );
      if (!isRecord(node)) return;
      for (const key of ['$anchor', '$dynamicAnchor'])
        if (typeof node[key] === 'string') {
          locations.add(location(base + '#' + node[key]));
          if (!resourcePointer) {
            locations.add(location(document.uri + '#' + node[key]));
            locations.add(location(requested + '#' + node[key]));
          }
        }
      for (const key of ['$ref', '$dynamicRef']) {
        if (typeof node[key] === 'string') {
          if (++references > limits.references) fail('RESOURCE_LIMIT', context);
          const target = absolute(node[key], base);
          refs.push(withoutFragment(target));
          targets.push(target);
        }
      }
      for (const [key, value] of Object.entries(node)) {
        if (mapSchemas.has(key))
          for (const [name, child] of Object.entries(value as Record<string, JsonValue>))
            walk(
              child,
              base,
              pointer + '/' + key + '/' + name.replace(/~/gu, '~0').replace(/\//gu, '~1'),
              resourcePointer,
            );
        if (oneSchema.has(key)) walk(value, base, pointer + '/' + key, resourcePointer);
        if (arraySchemas.has(key))
          for (const [index, child] of (value as readonly JsonValue[]).entries())
            walk(child, base, pointer + '/' + key + '/' + index, resourcePointer);
      }
    }
    walk(document.value, document.uri, '', '');
    // A different document may never steal a retrieval URI or an embedded resource's identity.
    for (const uri of [document.uri, requested]) {
      const old = resources.get(uri);
      if (old !== undefined && old !== document.value) fail('SCHEMA_INVALID', context);
    }
    for (const [id, node] of localIds) resources.set(id, node);
    resources.set(document.uri, document.value);
    resources.set(requested, document.value);
    visiting.add(document.uri);
    visiting.add(requested);
    for (const id of localIds.keys()) visiting.add(id);
    try {
      ajv.addSchema(document.value as AnySchema, document.uri);
      if (requested !== document.uri) ajv.addSchema(document.value as AnySchema, requested);
    } catch {
      fail('SCHEMA_INVALID', context);
    }
    for (const uri of new Set(refs)) {
      checkpoint();
      // Local recursive schemas remain native; a dependency back-edge across documents is refused.
      if (uri === document.uri || uri === requested || localIds.has(uri)) continue;
      if (visiting.has(uri)) fail('REFERENCE_CYCLE', context);
      if (!resources.has(uri) && !loaded.has(uri)) {
        const dependency = await load(uri);
        if (visiting.has(dependency.uri)) fail('REFERENCE_CYCLE', context);
        await add(dependency, uri, depth + 1);
      }
    }
    visiting.delete(document.uri);
    visiting.delete(requested);
    for (const id of localIds.keys()) visiting.delete(id);
    loaded.add(requested);
    loaded.add(document.uri);
  }
  await add(root, withoutFragment(entry), 0);
  checkpoint();
  // References into annotations are not schemas and must not bypass profile inspection.
  for (const target of targets)
    if (!locations.has(location(target))) fail('SCHEMA_INVALID', context);
  try {
    const validate = ajv.compile({ $schema: JSON_SCHEMA_DIALECT, $ref: entry });
    checkpoint();
    return validate;
  } catch {
    return fail('SCHEMA_INVALID', context);
  }
}
