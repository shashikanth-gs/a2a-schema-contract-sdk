import { lookup } from 'node:dns/promises';
import { Agent, request } from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';

import { ContractError, type ErrorContext, fail } from '../core/errors.js';
import { publicAddress } from './policy.js';

export interface Address {
  readonly address: string;
  readonly family: 4 | 6;
}
export interface NetworkPolicy {
  /** Exact origins, including port. Omitted: any origin passing the public-address policy. */
  readonly allowedOrigins?: readonly string[];
  /** Trusted administrator override for special-use addresses. Never read from discovery. */
  readonly allowAddress?: (address: string, hostname: string) => boolean;
  /** Trusted DNS implementation; the selected result is bound to the connection. */
  readonly lookup?: (hostname: string, signal: AbortSignal) => Promise<readonly Address[]>;
  /** Custom trust roots; certificate and original hostname verification remain mandatory. */
  readonly ca?: string | Buffer;
  /** Secrets scoped to this resolver identity and exact origin. Only Authorization is supported. */
  readonly authorization?: Readonly<Record<string, string>>;
}
export interface RetrievedResponse {
  readonly status: number;
  readonly location?: string;
  readonly contentType?: string;
  readonly encoding?: string;
  readonly bytes: Buffer;
}

export async function retrieve(
  url: URL,
  policy: NetworkPolicy,
  signal: AbortSignal,
  maxBytes: number,
  context: ErrorContext,
  authorizationOrigin: string,
): Promise<RetrievedResponse> {
  if (policy.allowedOrigins && !policy.allowedOrigins.includes(url.origin))
    fail('RESOLUTION_POLICY', context);
  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : policy.lookup
      ? await policy.lookup(hostname, signal)
      : await lookup(hostname, { all: true, verbatim: true });
  signal.throwIfAborted();
  if (!addresses.length || addresses.length > 32) fail('RESOLUTION_POLICY', context);
  // Mixed public/private answers are refused; no unsafe fallback or second DNS lookup.
  for (const address of addresses) {
    if (
      isIP(address.address) !== address.family ||
      (!publicAddress(address.address) && policy.allowAddress?.(address.address, hostname) !== true)
    )
      fail('RESOLUTION_POLICY', context);
  }
  const address = addresses[0]!;
  const authorization =
    url.origin === authorizationOrigin ? policy.authorization?.[url.origin] : undefined;
  // A fresh explicit agent avoids shared pools, environment proxies and cross-identity TLS sessions.
  const agent = new Agent({ keepAlive: false, maxCachedSessions: 0 });
  try {
    return await new Promise<RetrievedResponse>((resolve, reject) => {
      const req = request(
        {
          hostname: address.address,
          family: address.family,
          port: url.port || 443,
          path: url.pathname + url.search,
          method: 'GET',
          agent,
          signal,
          rejectUnauthorized: true,
          ...(policy.ca === undefined ? {} : { ca: policy.ca }),
          servername: literalFamily ? '' : hostname,
          checkServerIdentity: (_name, certificate) => checkServerIdentity(hostname, certificate),
          maxHeaderSize: 16384,
          headers: {
            Host: url.host,
            Accept: 'application/schema+json, application/json',
            'Accept-Encoding': 'identity',
            ...(authorization === undefined ? {} : { Authorization: authorization }),
          },
        },
        (response) => {
          const status = response.statusCode ?? 0;
          const common = {
            status,
            ...(response.headers.location === undefined
              ? {}
              : { location: response.headers.location }),
            ...(response.headers['content-type'] === undefined
              ? {}
              : { contentType: response.headers['content-type'] }),
            ...(response.headers['content-encoding'] === undefined
              ? {}
              : { encoding: response.headers['content-encoding'] }),
          };
          if (status !== 200) {
            response.destroy();
            resolve({ ...common, bytes: Buffer.alloc(0) });
            return;
          }
          const length = response.headers['content-length'];
          if (length !== undefined && (!/^[0-9]+$/u.test(length) || Number(length) > maxBytes)) {
            reject(new ContractError('RESOURCE_LIMIT', context));
            response.destroy();
            return;
          }
          let bytes = 0;
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > maxBytes) {
              reject(new ContractError('RESOURCE_LIMIT', context));
              response.destroy();
            } else chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('aborted', () => reject(new Error('Response aborted.')));
          response.on('end', () => resolve({ ...common, bytes: Buffer.concat(chunks) }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  } finally {
    agent.destroy();
  }
}
