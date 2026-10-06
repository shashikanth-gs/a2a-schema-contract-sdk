import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { getSchemaResource, SCHEMA_NAMES } from 'a2a-schema-contract/core';

const fixture = pathToFileURL(process.argv[2] + '/');
const json = async (name) => JSON.parse(await readFile(new URL(name, fixture), 'utf8'));
const manifest = await json('manifest.json');
for (const [name, expected] of Object.entries(manifest.files))
  assert.equal(
    createHash('sha256')
      .update(await readFile(new URL(name, fixture)))
      .digest('hex'),
    expected,
  );
const ajv = new Ajv2020({ strict: true, allErrors: false, validateFormats: true });
addFormats(ajv);
for (const name of SCHEMA_NAMES)
  ajv.addSchema(JSON.parse(await readFile(getSchemaResource(name), 'utf8')));
const cases = await json('conformance/cases.json');
const results = [];
async function check(schema, file, expected) {
  const validate = ajv.getSchema(
    `https://w3id.org/a2a-schema-contract/schema/draft/0.1/${schema}.schema.json`,
  );
  assert.equal(validate(await json(file)), expected, file);
  results.push({ schema, file, expected, result: 'PASS' });
}
for (const file of cases.catalog.valid) await check('catalog', 'conformance/' + file, true);
for (const file of cases.catalog.invalid) await check('catalog', 'conformance/' + file, false);
for (const [schema, file] of [
  ['extension-params', 'extension-params-inline.json'],
  ['extension-params', 'extension-params-external.json'],
  ['invocation-metadata', 'metadata/invocation-text-to-json.json'],
  ['invocation-metadata', 'metadata/invocation-no-input.json'],
  ['result-metadata', 'metadata/result-json.json'],
  ['result-metadata', 'metadata/result-no-output.json'],
  ['part-metadata', 'metadata/primary-input-part.json'],
  ['error-detail', 'metadata/error.json'],
])
  await check(schema, 'examples/' + file, true);
assert.equal(results.length, 20);
console.log(
  JSON.stringify({
    result: 'PASS',
    sourceCommit: manifest.commit,
    verifiedSourceFiles: Object.keys(manifest.files).length,
    installedStructuralCases: results.length,
    cases: results,
  }),
);
