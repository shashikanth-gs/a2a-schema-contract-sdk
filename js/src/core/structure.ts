import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ExtensionSchemaName, JsonValue } from './constants.js';
import { fail, type ErrorContext } from './errors.js';
import { absoluteUri } from './json.js';
import { structures } from './structures-data.js';

// Lazy, package-local configuration; importing core compiles nothing and does no I/O.
let validator: Ajv2020 | undefined;
export function checkStructure(
  name: ExtensionSchemaName,
  value: JsonValue,
  context: ErrorContext,
): void {
  if (validator === undefined) {
    validator = new Ajv2020({
      strict: true,
      allErrors: false,
      logger: false,
      formats: { uri: absoluteUri },
    });
    for (const schema of structures) validator.addSchema(schema);
  }
  const validate = validator.getSchema(
    `https://w3id.org/a2a-schema-contract/schema/draft/0.1/${name}.schema.json`,
  )!;
  if (!validate(value))
    fail(
      name === 'catalog' || name === 'extension-params' ? 'INVALID_STRUCTURE' : 'INVALID_METADATA',
      context,
    );
}
