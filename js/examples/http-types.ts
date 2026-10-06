import { AgentCard, Artifact, Task } from '@a2a-js/sdk';
import { AgentEvent, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { createContractServer, outputArtifact } from '@shashikanth-gs/a2a-schema-contract/server';
import {
  discoverContractClient,
  type InvocationOptions,
} from '@shashikanth-gs/a2a-schema-contract/client';
const contractId = 'urn:typed:1';
const representation = { id: 'json', mediaType: 'application/json' };
const server = createContractServer({
  card: AgentCard.fromJSON({ capabilities: {} }),
  catalog: {
    contracts: [
      {
        id: contractId,
        input: { presence: 'required', representations: [representation] },
        output: { presence: 'required', representations: [representation] },
      },
    ],
  },
  taskStore: new InMemoryTaskStore(),
  executor: {
    execute(context, bus) {
      const execution = server.execution(context);
      if (!execution.input.present) throw new Error('Missing input.');
      // Unknown discovered contracts remain runtime-validated JSON, without invented domain types.
      const artifact = outputArtifact(execution, execution.input.value);
      bus.publish(
        AgentEvent.task(
          Task.fromJSON({
            id: context.taskId,
            contextId: context.contextId,
            status: { state: 'TASK_STATE_COMPLETED' },
            artifacts: [Artifact.toJSON(artifact)],
          }),
        ),
      );
      return Promise.resolve();
    },
    cancelTask() {
      return Promise.resolve();
    },
  },
});
async function invoke(url: string) {
  const client = await discoverContractClient(url);
  const options: InvocationOptions = {
    contractId,
    input: { representationId: 'json', value: { nested: null } },
  };
  const result = await client.invoke(options, { signal: AbortSignal.timeout(5000) });
  if (result.payload?.present) {
    // @ts-expect-error Discovery does not justify a domain-specific static type.
    const domain: { nested: null } = result.payload.value;
    void domain;
  }
}
void invoke;
