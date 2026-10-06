import { parseCatalog } from 'a2a-schema-contract/core';
import { createValidationSession, type DiagnosticEvent } from 'a2a-schema-contract/operations';
const catalog = parseCatalog({
  contracts: [
    {
      id: 'urn:example:typed:1',
      input: {
        presence: 'required',
        representations: [{ id: 'json', mediaType: 'application/json' }],
      },
      output: { presence: 'none' },
    },
  ],
});
const diagnostics: DiagnosticEvent[] = [];
const session = createValidationSession(catalog, {
  deadlineMs: 500,
  concurrent: 2,
  diagnostics: (event) => diagnostics.push(event),
});
try {
  const value: unknown = await session.run(
    'validate',
    {
      contractId: 'urn:example:typed:1',
      direction: 'input',
      representationId: 'json',
      value: { example: true },
    },
    { signal: AbortSignal.timeout(1000) },
  );
  void value;
} finally {
  await session.close();
}
