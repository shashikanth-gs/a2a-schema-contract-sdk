import { AgentCard, Message, Part, Role } from '@a2a-js/sdk';
import { ClientFactory, JsonRpcTransportFactory, ServiceParameters, withA2AExtensions, type CallInterceptor } from '@a2a-js/sdk/client';
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore, type AgentExecutor } from '@a2a-js/sdk/server';
import { jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';

const uri = 'https://w3id.org/a2a-schema-contract/draft/0.1';
const interceptor: CallInterceptor = { async before(args) { void args.agentCard; }, async after(args) { void args.result; } };
const executor: AgentExecutor = {
  async execute(request, bus) {
    if (request.context.requestedExtensions?.includes(uri)) request.context.addActivatedExtension(uri);
    void request.request.configuration?.acceptedOutputModes;
    void request.context.user;
    void request.context.tenant;
    void request.context.state;
    const part: Part = { content: { $case: 'data', value: [1, false] }, metadata: {}, mediaType: 'application/json', filename: '' };
    const message: Message = { messageId: 'typed-probe', contextId: request.contextId, taskId: '', role: Role.ROLE_AGENT, parts: [part], metadata: {}, extensions: [uri], referenceTaskIds: [] };
    bus.publish(AgentEvent.message(message));
  },
  async cancelTask(_id, bus) { bus.finished(); },
};
const card = AgentCard.fromJSON({});
const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor);
void jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication });
const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory()], clientConfig: { interceptors: [interceptor] } });
async function invoke() {
  const client = await factory.createFromAgentCard(card);
  await client.sendMessage({ message: Message.fromJSON({}), metadata: {}, tenant: '', configuration: undefined }, {
    signal: AbortSignal.timeout(5000), serviceParameters: ServiceParameters.create(withA2AExtensions(uri)),
  });
}
void invoke;
