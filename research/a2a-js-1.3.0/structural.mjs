import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const base = new URL('../../vendor/contract/', import.meta.url);
const json = async name => JSON.parse(await readFile(new URL(name, base), 'utf8'));
const manifest = await json('manifest.json');
for (const [name, hash] of Object.entries(manifest.files)) {
  assert.equal(createHash('sha256').update(await readFile(new URL(name, base))).digest('hex'), hash, name);
}
const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
addFormats(ajv);
for (const name of Object.keys(manifest.files).filter(name => name.startsWith('schema/'))) ajv.addSchema(await json(name));
const results = [];
function check(schema, file, expected) {
  const validate = ajv.getSchema(`https://w3id.org/a2a-schema-contract/schema/draft/0.1/${schema}.schema.json`);
  return json(file).then(value => {
    assert.equal(validate(value), expected, file);
    results.push({ file, schema, expected, result: 'PASS' });
  });
}
const cases = await json('conformance/cases.json');
for (const file of cases.catalog.valid) await check('catalog', `conformance/${file}`, true);
for (const file of cases.catalog.invalid) await check('catalog', `conformance/${file}`, false);
for (const [schema, file] of [
  ['extension-params', 'extension-params-inline.json'], ['extension-params', 'extension-params-external.json'],
  ['invocation-metadata', 'metadata/invocation-text-to-json.json'], ['invocation-metadata', 'metadata/invocation-no-input.json'],
  ['result-metadata', 'metadata/result-json.json'], ['result-metadata', 'metadata/result-no-output.json'],
  ['part-metadata', 'metadata/primary-input-part.json'], ['error-detail', 'metadata/error.json'],
]) await check(schema, `examples/${file}`, true);
const require = createRequire(import.meta.url);
await writeFile(new URL('structural-report.json', import.meta.url), JSON.stringify({
  task: 'SDK-001', sourceCommit: manifest.commit, runtime: process.version,
  ajv: require('ajv/package.json').version, ajvFormats: require('ajv-formats/package.json').version,
  verifiedSourceFiles: Object.keys(manifest.files).length, passed: results.length, results,
  scope: 'Pinned structural fixtures only; domain format assertions in upstream runner do not define SDK payload semantics.',
}, null, 2) + '\n');
console.log(`All ${results.length} upstream structural checks passed; verified ${Object.keys(manifest.files).length} source hashes.`);
