import type { ContractCatalog } from '../core/catalog.js';

const catalogs = new WeakSet<object>();
export function rememberCatalog(catalog: ContractCatalog): void {
  catalogs.add(catalog);
}
export function preparedCatalog(value: unknown): ContractCatalog | undefined {
  return typeof value === 'object' && value !== null && catalogs.has(value)
    ? (value as ContractCatalog)
    : undefined;
}
