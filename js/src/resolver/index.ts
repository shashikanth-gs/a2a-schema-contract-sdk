import { createHash, timingSafeEqual } from 'node:crypto';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import {
  createCatalog,
  parseCatalog,
  type ContractCatalog,
  type Integrity,
} from '../core/catalog.js';
import { EXTENSION_URI, JSON_SCHEMA_DIALECT, type JsonValue } from '../core/constants.js';
import { ContractError, fail, type ErrorContext } from '../core/errors.js';
import { isRecord, snapshot } from '../core/json.js';
import { checkStructure } from '../core/structure.js';
import { retrieve, type NetworkPolicy } from './network.js';
import { documentUri, resourceUrl } from './policy.js';
import { rememberCatalog } from './prepared.js';
import { prepareSchema, type ResourceDocument } from './registry.js';

export type { NetworkPolicy, Address } from './network.js';
export const RESOLVER_LIMITS = Object.freeze({
  redirects: 3,
  responseBytes: 262144,
  totalBytes: 1048576,
  deadlineMs: 10000,
  documents: 32,
  references: 128,
  schemas: 256,
  referenceDepth: 8,
  cacheEntries: 32,
  cacheBytes: 1048576,
  concurrent: 4,
});
export type ResolverLimits = typeof RESOLVER_LIMITS;
export interface ResolverOptions extends NetworkPolicy {
  /** Exact document URIs whose immutability the administrator guarantees. ETags are not proof. */
  readonly immutableResources?: readonly string[];
  /** Independent pins for native transitive dependencies; a root digest does not pin them. */
  readonly resourceIntegrity?: Readonly<Record<string, Integrity>>;
  /** May only lower hard maxima. Zero disables cache entries/bytes or redirects. */
  readonly limits?: Partial<{ readonly [K in keyof ResolverLimits]: number }>;
}
export interface ResolutionOptions {
  readonly signal?: AbortSignal;
  readonly origin?: 'local' | 'remote';
}
export interface ContractResolver {
  resolveCatalog(value: unknown, options?: ResolutionOptions): Promise<ContractCatalog>;
  resolveExtensionParams(value: unknown, options?: ResolutionOptions): Promise<ContractCatalog>;
  resolveExtension(value: unknown, options?: ResolutionOptions): Promise<ContractCatalog>;
  /** Removes this instance's cached representation bytes; prepared catalogs remain usable offline. */
  clearCache(): void;
  readonly cache: { readonly entries: number; readonly bytes: number };
}
interface Cached {
  readonly bytes: Buffer;
  readonly uri: string;
}

/** Explicit instance ownership is the authentication/cache boundary. No globals or environment config. */
export function createContractResolver(options: ResolverOptions = {}): ContractResolver {
  const limits = { ...RESOLVER_LIMITS, ...options.limits };
  for (const [key, max] of Object.entries(RESOLVER_LIMITS)) {
    const value = limits[key as keyof ResolverLimits];
    if (
      !Number.isSafeInteger(value) ||
      value > max ||
      value < (key === 'cacheEntries' || key === 'cacheBytes' || key === 'redirects' ? 0 : 1)
    )
      throw new TypeError('Invalid resolver limit.');
  }
  const policy: NetworkPolicy = {
    ...(options.allowedOrigins
      ? { allowedOrigins: Object.freeze([...options.allowedOrigins]) }
      : {}),
    ...(options.authorization
      ? { authorization: Object.freeze({ ...options.authorization }) }
      : {}),
    ...(options.lookup ? { lookup: options.lookup } : {}),
    ...(options.allowAddress ? { allowAddress: options.allowAddress } : {}),
    ...(options.ca === undefined
      ? {}
      : { ca: Buffer.isBuffer(options.ca) ? Buffer.from(options.ca) : options.ca }),
  };
  const immutable = new Set(options.immutableResources ?? []);
  const pins = snapshot(options.resourceIntegrity ?? {}, {
    origin: 'local',
  }) as unknown as Readonly<Record<string, Integrity>>;
  const cache = new Map<string, Cached>();
  let cacheBytes = 0;
  let active = 0;
  async function run(
    value: unknown,
    kind: 'catalog' | 'params' | 'extension',
    resolution: ResolutionOptions = {},
  ): Promise<ContractCatalog> {
    const context: ErrorContext = { origin: resolution.origin ?? 'remote' };
    if (active >= limits.concurrent) fail('RESOURCE_LIMIT', context);
    active++;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), limits.deadlineMs);
    const signal = AbortSignal.any([
      timeout.signal,
      ...(resolution.signal ? [resolution.signal] : []),
    ]);
    let totalBytes = 0;
    let fetched = 0;
    // One coherent resource snapshot per preparation, including uncacheable mutable documents.
    const documents = new Map<string, Cached>();
    function checkpoint(): void {
      if (resolution.signal?.aborted) fail('RESOLUTION_ABORTED', context);
      if (timeout.signal.aborted) fail('RESOLUTION_TIMEOUT', context);
    }
    async function get(
      value: string,
      mediaType: 'application/json' | 'application/schema+json',
      declared?: Integrity,
      requireImmutable = false,
    ): Promise<ResourceDocument> {
      checkpoint();
      const initial = resourceUrl(value, context);
      const uri = documentUri(initial);
      if (mediaType === 'application/json' && initial.hash) fail('RESOLUTION_POLICY', context);
      const pin = declared ?? pins[uri];
      if (
        declared &&
        pins[uri] &&
        (declared.algorithm !== pins[uri].algorithm || declared.value !== pins[uri].value)
      )
        fail('INTEGRITY_MISMATCH', context);
      let digest: Buffer | undefined;
      if (pin) {
        if (
          (pin.algorithm !== 'sha-256' && pin.algorithm !== 'sha-512') ||
          typeof pin.value !== 'string'
        )
          fail('INVALID_STRUCTURE', context);
        digest = Buffer.from(pin.value, 'base64');
        if (
          digest.length !== (pin.algorithm === 'sha-256' ? 32 : 64) ||
          digest.toString('base64') !== pin.value
        )
          fail('INVALID_STRUCTURE', context);
      }
      const reusable = pin !== undefined || immutable.has(uri);
      if (requireImmutable && !reusable) fail('RESOLUTION_POLICY', context);
      const key = JSON.stringify([uri, mediaType, pin?.algorithm, pin?.value]);
      const existing = documents.get(key);
      if (!existing && ++fetched > limits.documents) fail('RESOURCE_LIMIT', context);
      let stored = existing ?? cache.get(key);
      if (stored) {
        if (cache.has(key)) {
          cache.delete(key);
          cache.set(key, stored);
        }
      } else {
        const visited = new Set<string>();
        let url = new URL(uri);
        let authorizationOrigin = url.origin;
        for (let redirects = 0; ; redirects++) {
          checkpoint();
          if (visited.has(url.href)) fail('REFERENCE_CYCLE', context);
          visited.add(url.href);
          const response = await retrieve(
            url,
            policy,
            signal,
            limits.responseBytes,
            context,
            authorizationOrigin,
          );
          checkpoint();
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            if (redirects >= limits.redirects) fail('RESOURCE_LIMIT', context);
            if (!response.location) fail('SCHEMA_UNAVAILABLE', context);
            if (/[\s\\]|%(?![0-9a-f]{2})/iu.test(response.location))
              fail('RESOLUTION_POLICY', context);
            let target: string;
            try {
              target = new URL(response.location, url).href;
            } catch {
              return fail('RESOLUTION_POLICY', context);
            }
            const next = resourceUrl(target, context);
            if (url.origin !== next.origin) authorizationOrigin = '';
            url = new URL(documentUri(next));
            continue;
          }
          if (response.status !== 200) fail('SCHEMA_UNAVAILABLE', context);
          if (response.encoding && response.encoding.toLowerCase() !== 'identity')
            fail('RESOLUTION_POLICY', context);
          const contentType = response.contentType?.toLowerCase().replace(/\s/gu, '');
          if (
            contentType !== mediaType &&
            contentType !== `${mediaType};charset=utf-8` &&
            contentType !== `${mediaType};charset="utf-8"`
          )
            fail('UNSUPPORTED_MEDIA_TYPE', context);
          stored = { bytes: response.bytes, uri: url.href };
          break;
        }
      }
      if (!existing && (totalBytes += stored.bytes.length) > limits.totalBytes)
        fail('RESOURCE_LIMIT', context);
      if (pin && digest) {
        const actual = createHash(pin.algorithm.replace('-', '')).update(stored.bytes).digest();
        if (!timingSafeEqual(actual, digest)) fail('INTEGRITY_MISMATCH', context);
      }
      let data: unknown;
      try {
        data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stored.bytes));
      } catch {
        return fail('SCHEMA_INVALID', context);
      }
      const frozen = snapshot(data, context);
      documents.set(key, stored);
      if (
        reusable &&
        !cache.has(key) &&
        limits.cacheEntries > 0 &&
        stored.bytes.length <= limits.cacheBytes
      ) {
        while (
          cache.size >= limits.cacheEntries ||
          cacheBytes + stored.bytes.length > limits.cacheBytes
        ) {
          const oldest = cache.keys().next().value!;
          cacheBytes -= cache.get(oldest)!.bytes.length;
          cache.delete(oldest);
        }
        cache.set(key, stored);
        cacheBytes += stored.bytes.length;
      }
      return { value: frozen, uri: stored.uri };
    }
    async function work(): Promise<ContractCatalog> {
      checkpoint();
      let data = snapshot(value, context);
      if (kind === 'extension') {
        if (!isRecord(data) || typeof data.uri !== 'string') fail('INVALID_STRUCTURE', context);
        if (data.uri !== EXTENSION_URI) fail('VERSION_MISMATCH', context);
        if (data.required !== undefined && typeof data.required !== 'boolean')
          fail('INVALID_STRUCTURE', context);
        data = data.params!;
      }
      if (kind !== 'catalog') {
        checkStructure('extension-params', data, context);
        const descriptor = (data as { catalog: Record<string, JsonValue> }).catalog;
        data = Object.hasOwn(descriptor, 'inline')
          ? descriptor.inline!
          : (
              await get(
                descriptor.uri as string,
                'application/json',
                descriptor.integrity as unknown as Integrity | undefined,
                true,
              )
            ).value;
      }
      const structural = parseCatalog(data, context.origin);
      const validators = new Map<string, ValidateFunction>();
      for (const contract of structural.contracts)
        for (const direction of ['input', 'output'] as const) {
          for (const representation of contract[direction].representations ?? []) {
            const descriptor = representation.schema;
            if (
              !descriptor ||
              descriptor.bundle ||
              descriptor.dialect !== JSON_SCHEMA_DIALECT ||
              descriptor.mediaType !== 'application/schema+json'
            )
              continue;
            const scoped = {
              ...context,
              contractId: contract.id,
              direction,
              representationId: representation.id,
            };
            // Synthetic private base is only an offline identifier; it is never fetched.
            const inlineBase = `urn:a2a-schema-contract:inline:${validators.size}`;
            const root = Object.hasOwn(descriptor, 'inline')
              ? { value: descriptor.inline!, uri: inlineBase }
              : await get(descriptor.uri!, 'application/schema+json', descriptor.integrity);
            const entry = descriptor.uri ? resourceUrl(descriptor.uri, scoped).href : inlineBase;
            const validate = await prepareSchema(
              root,
              entry,
              (uri) => get(uri, 'application/schema+json'),
              limits,
              scoped,
              checkpoint,
            );
            validators.set(JSON.stringify([contract.id, direction, representation.id]), validate);
          }
        }
      const catalog = createCatalog(data, context.origin, (descriptor, scoped) => {
        if (descriptor.bundle) fail('SCHEMA_UNAVAILABLE', scoped);
        if (descriptor.dialect !== JSON_SCHEMA_DIALECT) fail('UNSUPPORTED_DIALECT', scoped);
        if (descriptor.mediaType !== 'application/schema+json')
          fail('UNSUPPORTED_MEDIA_TYPE', scoped);
        const validate = validators.get(
          JSON.stringify([scoped.contractId, scoped.direction, scoped.representationId]),
        );
        if (!validate) fail('SCHEMA_UNAVAILABLE', scoped);
        return validate;
      });
      checkpoint();
      rememberCatalog(catalog);
      return catalog;
    }
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => {
        try {
          checkpoint();
        } catch (error) {
          reject(error instanceof Error ? error : new ContractError('RESOLUTION_ABORTED', context));
        }
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([work(), aborted]);
    } catch (error) {
      checkpoint();
      if (error instanceof ContractError) throw error;
      return fail('SCHEMA_UNAVAILABLE', context);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      timeout.abort();
      active--;
    }
  }
  return Object.freeze({
    resolveCatalog: (value: unknown, resolution?: ResolutionOptions) =>
      run(value, 'catalog', resolution),
    resolveExtensionParams: (value: unknown, resolution?: ResolutionOptions) =>
      run(value, 'params', resolution),
    resolveExtension: (value: unknown, resolution?: ResolutionOptions) =>
      run(value, 'extension', resolution),
    clearCache() {
      cache.clear();
      cacheBytes = 0;
    },
    get cache() {
      return Object.freeze({ entries: cache.size, bytes: cacheBytes });
    },
  });
}
