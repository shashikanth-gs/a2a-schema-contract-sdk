import { isIP } from 'node:net';
import { fail, type ErrorContext } from '../core/errors.js';

/** Conservative address policy: reject special-use IPv4 and non-global/special IPv6. */
export function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c, d] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 168 && b === 63 && c === 129 && d === 16) ||
      a! >= 224 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family !== 6) return false;
  // URL canonicalization expands dotted IPv4 tails and normalizes zero compression.
  const host = new URL(`https://[${address}]/`).hostname.slice(1, -1);
  const [left, right] = host.split('::');
  const head = left ? left.split(':') : [];
  const tail = right ? right.split(':') : [];
  const words =
    right === undefined
      ? head
      : [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail];
  const first = parseInt(words[0]!, 16);
  const second = parseInt(words[1]!, 16);
  // Fail closed on IPv4-mapped/compatible, NAT64, ULA, multicast, link-local and future space.
  return (
    (first & 0xe000) === 0x2000 &&
    !(
      (first === 0x2001 && second < 0x200) ||
      (first === 0x2001 && second === 0xdb8) ||
      first === 0x2002 ||
      (first === 0x3fff && second < 0x1000)
    )
  );
}

export function resourceUrl(value: string, context: ErrorContext): URL {
  if (
    typeof value !== 'string' ||
    value.length > 8192 ||
    /[\s\\]|%(?![0-9a-f]{2})/iu.test(value) ||
    /[^\x21-\x7e]/u.test(value)
  )
    fail('RESOLUTION_POLICY', context);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail('RESOLUTION_POLICY', context);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !url.hostname ||
    url.hostname.endsWith('.')
  )
    fail('RESOLUTION_POLICY', context);
  if (/(?:^|[/:#?=&])latest(?:$|[/:#?=&])/iu.test(url.href)) fail('RESOLUTION_POLICY', context);
  return url;
}

export function documentUri(url: URL): string {
  const copy = new URL(url);
  copy.hash = '';
  return copy.href;
}
