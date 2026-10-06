import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function json(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  validateFormats: true
});
addFormats(ajv);

const schemaDirectory = path.join(root, "schema");
const schemaNames = (await readdir(schemaDirectory))
  .filter((name) => name.endsWith(".schema.json"))
  .sort();

for (const name of schemaNames) {
  ajv.addSchema(await json(`schema/${name}`));
}

const catalogValidator = ajv.getSchema(
  "https://w3id.org/a2a-schema-contract/schema/draft/0.1/catalog.schema.json"
);
const paramsValidator = ajv.getSchema(
  "https://w3id.org/a2a-schema-contract/schema/draft/0.1/extension-params.schema.json"
);
const invocationValidator = ajv.getSchema(
  "https://w3id.org/a2a-schema-contract/schema/draft/0.1/invocation-metadata.schema.json"
);
const resultValidator = ajv.getSchema(
  "https://w3id.org/a2a-schema-contract/schema/draft/0.1/result-metadata.schema.json"
);
const partValidator = ajv.getSchema(
  "https://w3id.org/a2a-schema-contract/schema/draft/0.1/part-metadata.schema.json"
);
const errorValidator = ajv.getSchema(
  "https://w3id.org/a2a-schema-contract/schema/draft/0.1/error-detail.schema.json"
);

let failures = 0;

function check(validator, value, label, expected = true) {
  const actual = validator(value);
  if (actual !== expected) {
    failures += 1;
    console.error(`FAIL ${label}: expected ${expected}, received ${actual}`);
    if (validator.errors) console.error(JSON.stringify(validator.errors, null, 2));
  } else {
    console.log(`PASS ${label}`);
  }
}

const cases = await json("conformance/cases.json");
for (const relativePath of cases.catalog.valid) {
  check(
    catalogValidator,
    await json(path.join("conformance", relativePath)),
    `valid catalog ${relativePath}`
  );
}
for (const relativePath of cases.catalog.invalid) {
  check(
    catalogValidator,
    await json(path.join("conformance", relativePath)),
    `invalid catalog ${relativePath}`,
    false
  );
}

check(
  paramsValidator,
  await json("examples/extension-params-inline.json"),
  "inline extension params"
);
check(
  paramsValidator,
  await json("examples/extension-params-external.json"),
  "external extension params"
);
check(
  invocationValidator,
  await json("examples/metadata/invocation-text-to-json.json"),
  "invocation metadata"
);
check(
  invocationValidator,
  await json("examples/metadata/invocation-no-input.json"),
  "no-input invocation metadata"
);
check(
  resultValidator,
  await json("examples/metadata/result-json.json"),
  "result metadata"
);
check(
  resultValidator,
  await json("examples/metadata/result-no-output.json"),
  "no-output result metadata"
);
check(
  partValidator,
  await json("examples/metadata/primary-input-part.json"),
  "primary Part metadata"
);
check(
  errorValidator,
  await json("examples/metadata/error.json"),
  "error detail"
);

if (failures > 0) {
  process.exitCode = 1;
} else {
  console.log(`\nAll ${cases.catalog.valid.length + cases.catalog.invalid.length + 8} checks passed.`);
}
