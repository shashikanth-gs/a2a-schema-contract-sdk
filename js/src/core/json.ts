import { types } from 'node:util';

import type { JsonValue } from './constants.js';
import { type ErrorContext, fail } from './errors.js';

export const LIMITS = Object.freeze({
  depth: 32,
  nodes: 4096,
  bytes: 262144,
  string: 8192,
  schemas: 256,
  references: 128,
  pattern: 128,
  parts: 128,
});

export function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Snapshot only JSON data properties. Never reads getters or mutates caller objects. */
export function snapshot(value: unknown, context: ErrorContext): JsonValue {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  function string(value: string): string {
    if ([...value].length > LIMITS.string) fail('RESOURCE_LIMIT', context);
    bytes += Buffer.byteLength(JSON.stringify(value), 'utf8');
    // Reject lone surrogates: they cannot round-trip through the UTF-8 text carrier.
    if (!value.isWellFormed()) fail('NON_JSON_VALUE', context);
    return value;
  }
  function visit(value: unknown, depth: number): JsonValue {
    nodes++;
    bytes += 8;
    if (depth > LIMITS.depth || nodes > LIMITS.nodes || bytes > LIMITS.bytes)
      fail('RESOURCE_LIMIT', context);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return string(value);
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
        fail('UNSUPPORTED_NUMBER', context);
      bytes += Buffer.byteLength(JSON.stringify(value), 'utf8');
      return value;
    }
    if (typeof value !== 'object') fail('NON_JSON_VALUE', context);
    if (types.isProxy(value)) fail('NON_JSON_VALUE', context);
    if (ancestors.has(value)) fail('NON_JSON_VALUE', context);
    const array = Array.isArray(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (
      array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
    )
      fail('NON_JSON_VALUE', context);
    const keys = Reflect.ownKeys(value);
    if (keys.length > LIMITS.nodes) fail('RESOURCE_LIMIT', context);
    ancestors.add(value);
    const result: JsonValue[] | Record<string, JsonValue> = array ? [] : {};
    let entries = 0;
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') fail('NON_JSON_VALUE', context);
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !('value' in descriptor)) fail('NON_JSON_VALUE', context);
      if (array && (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length))
        fail('NON_JSON_VALUE', context);
      string(key);
      Object.defineProperty(result, key, {
        value: visit(descriptor.value, depth + 1),
        enumerable: true,
        writable: false,
        configurable: false,
      });
      entries++;
    }
    if (array && entries !== value.length) fail('NON_JSON_VALUE', context);
    ancestors.delete(value);
    return Object.freeze(result);
  }
  const result = visit(value, 0);
  if (bytes > LIMITS.bytes) fail('RESOURCE_LIMIT', context);
  return result;
}

export function absoluteUri(value: string): boolean {
  if (typeof value !== 'string') return false;
  if (
    !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/u.test(value) ||
    /[^\x21-\x7e]|%(?![0-9A-Fa-f]{2})/u.test(value)
  )
    return false;
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    return true;
  } catch {
    return false;
  }
}

/** Recognize explicit numeric version segments; immutability remains advertiser-owned. */
export function versionedId(value: string): boolean {
  return (
    absoluteUri(value) &&
    !/(?:^|[/:#?=&])latest(?:$|[/:#?=&])/iu.test(value) &&
    /(?:[/:#])v?[0-9]+(?:[.][0-9]+)*(?:[-][A-Za-z0-9.-]+)?(?:$|[/:#])/u.test(value)
  );
}
