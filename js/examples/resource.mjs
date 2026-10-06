import { readFile } from 'node:fs/promises';
import { EXTENSION_URI, getSchemaResource } from 'a2a-schema-contract/core';

// Explicit local resource access; no discovery, network or domain validation is performed.
const catalogStructure = JSON.parse(await readFile(getSchemaResource('catalog'), 'utf8'));
console.log(EXTENSION_URI);
console.log(catalogStructure.$id);
