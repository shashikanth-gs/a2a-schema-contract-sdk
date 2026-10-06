/** Only this released peer has compatibility evidence. */
export const A2A_JS_SDK_VERSION = '1.3.0' as const;
export { guardResponseFetch } from '../../client/index.js';
export { guardJsonRpcRequest } from './boundary.js';
export type { Client, RequestOptions } from '@a2a-js/sdk/client';
export type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
