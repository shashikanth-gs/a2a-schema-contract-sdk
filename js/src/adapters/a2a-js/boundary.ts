import { isDeepStrictEqual } from 'node:util';
import {
  Artifact,
  Message,
  Part,
  Role,
  Task,
  TaskState,
  type SendMessageRequest,
} from '@a2a-js/sdk';
import { ContentTypeNotSupportedError, RequestMalformedError } from '@a2a-js/sdk/errors';
import {
  ContractError,
  EXTENSION_URI,
  matchMediaTypes,
  validateInvocation,
  validateResult,
  type ContractCatalog,
  type InvocationSelection,
  type Payload,
  type PreparedRepresentation,
} from '../../core/index.js';
import { snapshot } from '../../core/json.js';

export interface ContractSelection extends InvocationSelection {
  readonly output?: PreparedRepresentation;
}
export function reject(): never {
  throw new ContractError('INVALID_METADATA', { origin: 'remote' });
}
export function mapped(error: unknown): Error {
  const detail = error instanceof ContractError ? error.detail : undefined;
  const options = {
    message: 'Schema Contract request rejected.',
    ...(detail ? { metadata: { [EXTENSION_URI]: JSON.stringify(detail) } } : {}),
  };
  return detail?.code === 'REPRESENTATION_NOT_SUPPORTED'
    ? new ContentTypeNotSupportedError(options)
    : new RequestMalformedError(options);
}
export function selectRequest(
  catalog: ContractCatalog,
  request: SendMessageRequest,
): ContractSelection {
  if (
    !request.message ||
    request.message.metadata?.[EXTENSION_URI] !== undefined ||
    request.configuration?.returnImmediately
  )
    reject();
  const selection = validateInvocation(
    catalog,
    request.metadata,
    request.message.parts.map((p) => Part.toJSON(p)),
    'a2a-js-1.3.0',
  );
  const contract = catalog.getContract(selection.invocation.contractId);
  if (contract.output.presence === 'none') return Object.freeze(selection);
  const ids = selection.invocation.acceptedOutputRepresentationIds;
  const modes = request.configuration?.acceptedOutputModes;
  for (const rep of contract.output.representations ?? []) {
    if (ids && !ids.includes(rep.id)) continue;
    if (modes?.length && !modes.some((mode) => matchMediaTypes(mode, rep.mediaType))) continue;
    if (
      !catalog.capabilities(contract.id, 'output').find((cap) => cap.representation.id === rep.id)
        ?.supported
    )
      continue;
    return Object.freeze({ ...selection, output: catalog.select(contract.id, 'output', rep.id) });
  }
  throw new ContractError('REPRESENTATION_NOT_SUPPORTED', {
    origin: 'remote',
    contractId: contract.id,
    direction: 'output',
  });
}
export function echo(selection: ContractSelection, present: boolean): Record<string, unknown> {
  return {
    contractId: selection.invocation.contractId,
    ...(present ? { outputRepresentationId: selection.output!.representation.id } : {}),
  };
}
/** Inspect carriers before official protobuf codecs can coerce or discard fields. */
export function guardParts(parts: unknown): void {
  const copy = snapshot(parts, { origin: 'remote' });
  if (!Array.isArray(copy) || !copy.length || copy.length > 128) reject();
  for (const part of copy) {
    if (!isRecord(part)) reject();
    const keys = ['data', 'text', 'raw', 'url'].filter((key) => Object.hasOwn(part, key));
    if (keys.length !== 1) reject();
    if (part.data === null) throw new ContractError('UNSUPPORTED_CARRIER', { origin: 'remote' });
    if (part.text !== undefined && typeof part.text !== 'string') reject();
    if (
      part.raw !== undefined &&
      (typeof part.raw !== 'string' ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(part.raw))
    )
      reject();
    if (part.url !== undefined && (typeof part.url !== 'string' || !URL.canParse(part.url)))
      reject();
    if (part.mediaType !== undefined && typeof part.mediaType !== 'string') reject();
    if (part.filename !== undefined && typeof part.filename !== 'string') reject();
    if (part.metadata !== undefined && !isRecord(part.metadata)) reject();
  }
}
export function guardContainer(value: unknown): void {
  if (!isRecord(value)) reject();
  for (const field of ['id', 'messageId', 'taskId', 'contextId'])
    if (value[field] !== undefined && typeof value[field] !== 'string') reject();
  if (value.parts !== undefined) {
    guardParts(value.parts);
    if (value.role !== undefined && value.role !== 'ROLE_AGENT' && value.role !== 'ROLE_USER')
      reject();
    if (typeof value.messageId !== 'string' || !value.messageId) reject();
  }
  if (value.artifacts !== undefined) {
    if (!Array.isArray(value.artifacts)) reject();
    const ids = new Set<string>();
    for (const artifact of value.artifacts) {
      if (
        !isRecord(artifact) ||
        typeof artifact.artifactId !== 'string' ||
        !artifact.artifactId ||
        ids.has(artifact.artifactId)
      )
        reject();
      ids.add(artifact.artifactId);
      guardParts(artifact.parts);
    }
  }
  if (isRecord(value.status) && value.status.message !== undefined) {
    guardContainer(value.status.message);
    if (
      isRecord(value.status.message) &&
      Array.isArray(value.status.message.parts) &&
      value.status.message.parts.some(
        (part) =>
          isRecord(part) && isRecord(part.metadata) && Object.hasOwn(part.metadata, EXTENSION_URI),
      )
    )
      reject();
  }
}
export function guardJsonRpcRequest(value: unknown): void {
  if (!isRecord(value)) reject();
  if (value.method !== 'SendMessage' && value.method !== 'SendStreamingMessage') return;
  if (!isRecord(value.params) || !isRecord(value.params.message)) reject();
  guardParts(value.params.message.parts);
  if (value.params.metadata !== undefined && !isRecord(value.params.metadata)) reject();
  if (value.params.configuration !== undefined) {
    if (!isRecord(value.params.configuration)) reject();
    const config = value.params.configuration;
    if (
      config.acceptedOutputModes !== undefined &&
      (!Array.isArray(config.acceptedOutputModes) ||
        config.acceptedOutputModes.some((mode) => typeof mode !== 'string'))
    )
      reject();
    if (config.returnImmediately !== undefined && typeof config.returnImmediately !== 'boolean')
      reject();
  }
  for (const name of ['messageId', 'taskId', 'contextId'])
    if (value.params.message[name] !== undefined && typeof value.params.message[name] !== 'string')
      reject();
  if (
    value.params.message.role !== 'ROLE_USER' ||
    typeof value.params.message.messageId !== 'string' ||
    !value.params.message.messageId
  )
    reject();
}
export const stopStates = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
  TaskState.TASK_STATE_INPUT_REQUIRED,
]);
export function checkEcho(metadata: Record<string, unknown> | undefined, expected: unknown): void {
  if (
    metadata?.[EXTENSION_URI] !== undefined &&
    !isDeepStrictEqual(metadata[EXTENSION_URI], expected)
  )
    reject();
}
export function consumeResult(
  catalog: ContractCatalog,
  selection: ContractSelection,
  result: Message | Task,
): Payload | undefined {
  const contractId = selection.invocation.contractId;
  if ('parts' in result) {
    if (result.role !== Role.ROLE_AGENT) reject();
    guardParts(result.parts.map((p) => Part.toJSON(p)));
    if (catalog.getContract(contractId).output.presence === 'none') reject();
    return validateResult(
      catalog,
      contractId,
      result.metadata,
      result.parts.map((p) => Part.toJSON(p)),
      selection.output?.representation.id,
      'a2a-js-1.3.0',
    );
  }
  guardContainer(Task.toJSON(result));
  if (!result.id || !result.contextId || !result.status) reject();
  if (result.status.state !== TaskState.TASK_STATE_COMPLETED) {
    if (!stopStates.has(result.status.state)) reject();
    if (
      result.artifacts.some((a) => a.parts.some((p) => p.metadata?.[EXTENSION_URI] !== undefined))
    )
      reject();
    if (result.status.state === TaskState.TASK_STATE_INPUT_REQUIRED) {
      checkEcho(result.metadata, echo(selection, selection.output !== undefined));
      if (result.metadata?.[EXTENSION_URI] === undefined) reject();
    }
    return undefined;
  }
  const parts = result.artifacts.flatMap((a) => a.parts.map((p) => Part.toJSON(p)));
  for (const artifact of result.artifacts)
    checkEcho(artifact.metadata, result.metadata?.[EXTENSION_URI]);
  return validateResult(
    catalog,
    contractId,
    result.metadata,
    parts,
    selection.output?.representation.id,
    'a2a-js-1.3.0',
  );
}
export function cloneArtifact(artifact: Artifact): Artifact {
  if (!artifact.artifactId) reject();
  guardParts(artifact.parts.map((p) => Part.toJSON(p)));
  return Artifact.fromJSON(Artifact.toJSON(artifact));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
