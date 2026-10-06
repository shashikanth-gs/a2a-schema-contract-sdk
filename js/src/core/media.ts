import { type ErrorContext, fail } from './errors.js';

export type Media = 'json' | 'text';
export function media(value: string, context: ErrorContext): Media {
  if (typeof value !== 'string' || /[\r\n]/u.test(value)) fail('UNSUPPORTED_MEDIA_TYPE', context);
  if (/^application\/json$/iu.test(value)) return 'json';
  if (/^text\/plain(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/iu.test(value)) return 'text';
  return fail('UNSUPPORTED_MEDIA_TYPE', context);
}
/** Exact supported media semantics; no wildcard, suffix, q or encoding inference. */
export function matchMediaTypes(first: string, second: string): boolean {
  try {
    return media(first, { origin: 'local' }) === media(second, { origin: 'local' });
  } catch {
    return false;
  }
}
