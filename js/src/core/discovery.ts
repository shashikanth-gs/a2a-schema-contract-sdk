import type { Contract, ContractCatalog, RepresentationCapability } from './catalog.js';
import { EXTENSION_URI, type JsonValue } from './constants.js';
import { fail } from './errors.js';
import { isRecord, snapshot } from './json.js';
import { checkStructure } from './structure.js';

export interface ContractDescription {
  readonly contract: Contract;
  readonly input: readonly RepresentationCapability[];
  readonly output: readonly RepresentationCapability[];
}
export interface SkillContracts {
  readonly skill: { readonly id: string; readonly name?: string; readonly description?: string };
  readonly contracts: readonly ContractDescription[];
}
export interface ContractDiscovery {
  readonly contracts: readonly ContractDescription[];
  readonly skills: readonly SkillContracts[];
  readonly unassociated: readonly ContractDescription[];
  readonly staleAssociations: readonly { readonly contractId: string; readonly skillId: string }[];
}
/** Trusted synchronous inspection. Async clients run this capability work in owned workers. */
export function describeContracts(
  catalog: ContractCatalog,
  skills: unknown = [],
): ContractDiscovery {
  const context = { origin: 'local' as const };
  const data = snapshot(skills, context);
  if (!Array.isArray(data)) fail('INVALID_STRUCTURE', context);
  const ids = new Set<string>();
  const advertised = data.map((skill: JsonValue) => {
    if (
      !isRecord(skill) ||
      typeof skill.id !== 'string' ||
      !skill.id ||
      (skill.name !== undefined && typeof skill.name !== 'string') ||
      (skill.description !== undefined && typeof skill.description !== 'string')
    )
      fail('INVALID_STRUCTURE', context);
    if (ids.has(skill.id)) fail('DUPLICATE_IDENTIFIER', context);
    ids.add(skill.id);
    return Object.freeze({
      id: skill.id,
      ...(skill.name === undefined ? {} : { name: skill.name }),
      ...(skill.description === undefined ? {} : { description: skill.description }),
    });
  });
  const contracts = Object.freeze(
    catalog.contracts.map((contract) =>
      Object.freeze({
        contract,
        input: catalog.capabilities(contract.id, 'input'),
        output: catalog.capabilities(contract.id, 'output'),
      }),
    ),
  );
  return Object.freeze({
    contracts,
    skills: Object.freeze(
      advertised.map((skill) =>
        Object.freeze({
          skill,
          contracts: Object.freeze(
            contracts.filter((c) => c.contract.skillIds?.includes(skill.id)),
          ),
        }),
      ),
    ),
    unassociated: Object.freeze(contracts.filter((c) => !c.contract.skillIds?.length)),
    staleAssociations: Object.freeze(
      contracts.flatMap((c) =>
        (c.contract.skillIds ?? [])
          .filter((id) => !ids.has(id))
          .map((skillId) => Object.freeze({ contractId: c.contract.id, skillId })),
      ),
    ),
  });
}

export interface SimpleInvocation {
  readonly contractId: string;
  readonly input?: unknown;
  readonly inputRepresentationId?: string;
  readonly acceptedOutputRepresentationIds?: readonly string[];
}
export interface SelectedInvocation {
  readonly contractId: string;
  readonly input?: { readonly representationId: string; readonly value: JsonValue };
  readonly acceptedOutputRepresentationIds?: readonly string[];
}
/** Choose only unambiguous supported representations; the contract itself is always explicit. */
export function selectInvocation(
  catalog: ContractCatalog,
  options: SimpleInvocation,
): SelectedInvocation {
  const context = { origin: 'local' as const };
  const data = snapshot(options, context);
  if (!isRecord(data) || typeof data.contractId !== 'string') fail('INVALID_STRUCTURE', context);
  const contract = catalog.getContract(data.contractId, 'local');
  const present = Object.hasOwn(data, 'input');
  if (
    (contract.input.presence === 'required' && !present) ||
    (contract.input.presence === 'none' && present)
  )
    fail('PAYLOAD_PRESENCE_VIOLATION', context);
  if (!present && data.inputRepresentationId !== undefined) fail('INVALID_METADATA', context);
  function supported(direction: 'input' | 'output'): string[] {
    return catalog
      .capabilities(contract.id, direction)
      .filter((c) => c.supported)
      .map((c) => c.representation.id);
  }
  function sole(direction: 'input' | 'output'): string {
    const choices = supported(direction);
    const scoped = { ...context, contractId: contract.id, direction };
    if (!choices.length) fail('REPRESENTATION_NOT_SUPPORTED', scoped);
    if (choices.length !== 1) fail('AMBIGUOUS_SELECTION', scoped);
    return choices[0]!;
  }
  let input: SelectedInvocation['input'];
  if (present) {
    if (data.inputRepresentationId !== undefined && typeof data.inputRepresentationId !== 'string')
      fail('INVALID_STRUCTURE', context);
    const representationId = data.inputRepresentationId ?? sole('input');
    input = Object.freeze({
      representationId,
      value: catalog
        .select(contract.id, 'input', representationId, 'local')
        .validate(data.input, 'local'),
    });
  }
  let accepted: readonly string[] | undefined;
  if (contract.output.presence === 'none') {
    if (data.acceptedOutputRepresentationIds !== undefined) fail('INVALID_METADATA', context);
  } else if (data.acceptedOutputRepresentationIds === undefined)
    accepted = Object.freeze([sole('output')]);
  else {
    const candidates = data.acceptedOutputRepresentationIds;
    if (
      !Array.isArray(candidates) ||
      !candidates.length ||
      candidates.some((id) => typeof id !== 'string') ||
      new Set(candidates).size !== candidates.length
    )
      fail('INVALID_STRUCTURE', context);
    const available = supported('output');
    for (const id of candidates)
      if (!available.includes(id as string)) fail('REPRESENTATION_NOT_SUPPORTED', context);
    accepted = candidates as readonly string[];
  }
  return Object.freeze({
    contractId: contract.id,
    ...(input ? { input } : {}),
    ...(accepted ? { acceptedOutputRepresentationIds: accepted } : {}),
  });
}

export interface AdvertisementOptions {
  readonly required?: boolean;
  readonly catalogDelivery?: 'inline' | 'external';
}
/** Build a portable AgentExtension using validated discovery data; no network I/O. */
export function createContractExtension(
  catalog: ContractCatalog,
  options: AdvertisementOptions = {},
) {
  const context = { origin: 'local' as const };
  if (
    options.catalogDelivery !== undefined &&
    options.catalogDelivery !== 'inline' &&
    options.catalogDelivery !== 'external'
  )
    fail('INVALID_STRUCTURE', context);
  if (options.required !== undefined && typeof options.required !== 'boolean')
    fail('INVALID_STRUCTURE', context);
  const reference = options.catalogDelivery === 'external' ? catalog.reference : undefined;
  if (options.catalogDelivery === 'external' && !reference) fail('SCHEMA_UNAVAILABLE', context);
  const params = snapshot(
    { catalog: reference ?? { inline: { contracts: catalog.contracts } } },
    context,
  ) as { readonly [key: string]: JsonValue };
  checkStructure('extension-params', params, context);
  return Object.freeze({
    uri: EXTENSION_URI,
    required: options.required ?? false,
    description: 'Schema Contract',
    params,
  });
}
