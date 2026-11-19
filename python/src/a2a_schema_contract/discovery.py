"""Skill-associated inspection and explicit, unambiguous invocation selection."""

from dataclasses import dataclass
from typing import Literal, cast

from .catalog import ContractCatalog
from .core import MISSING, ContractError, ErrorContext, snapshot
from .core.models import Capability, Contract, JsonDocument


@dataclass(frozen=True, slots=True)
class Skill:
    id: str
    name: str | None
    description: str | None


@dataclass(frozen=True, slots=True)
class ContractDescription:
    contract: Contract
    input: tuple[Capability, ...]
    output: tuple[Capability, ...]


@dataclass(frozen=True, slots=True)
class SkillContracts:
    skill: Skill
    contracts: tuple[ContractDescription, ...]


@dataclass(frozen=True, slots=True)
class ContractDiscovery:
    contracts: tuple[ContractDescription, ...]
    skills: tuple[SkillContracts, ...]
    unassociated: tuple[ContractDescription, ...]
    stale_associations: tuple[tuple[str, str], ...]


def describe_contracts(catalog: ContractCatalog, skills: object = MISSING) -> ContractDiscovery:
    data = snapshot([] if skills is MISSING else skills)
    if not isinstance(data, list):
        raise ContractError("INVALID_STRUCTURE")
    advertised: list[Skill] = []
    ids: set[str] = set()
    for item in data:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"]:
            raise ContractError("INVALID_STRUCTURE")
        for field in ("name", "description"):
            if field in item and not isinstance(item[field], str):
                raise ContractError("INVALID_STRUCTURE")
        identifier = cast("str", item["id"])
        if identifier in ids:
            raise ContractError("DUPLICATE_IDENTIFIER")
        ids.add(identifier)
        advertised.append(
            Skill(
                identifier,
                cast("str | None", item.get("name")),
                cast("str | None", item.get("description")),
            )
        )
    contracts = tuple(
        ContractDescription(
            contract,
            catalog.capabilities(contract.id, "input"),
            catalog.capabilities(contract.id, "output"),
        )
        for contract in catalog.contracts
    )
    return ContractDiscovery(
        contracts,
        tuple(
            SkillContracts(
                skill, tuple(item for item in contracts if skill.id in item.contract.skill_ids)
            )
            for skill in advertised
        ),
        tuple(item for item in contracts if not item.contract.skill_ids),
        tuple(
            (item.contract.id, skill_id)
            for item in contracts
            for skill_id in item.contract.skill_ids
            if skill_id not in ids
        ),
    )


@dataclass(frozen=True, slots=True)
class SelectedInvocation:
    contract_id: str
    input: JsonDocument | None
    input_representation_id: str | None
    accepted_output_representation_ids: tuple[str, ...] | None


def select_invocation(
    catalog: ContractCatalog,
    contract_id: str,
    *,
    input: object = MISSING,
    input_representation_id: str | None = None,
    accepted_output_representation_ids: tuple[str, ...] | list[str] | None = None,
    allow_server_selection: bool = False,
) -> SelectedInvocation:
    if type(allow_server_selection) is not bool or (
        allow_server_selection and accepted_output_representation_ids is not None
    ):
        raise ContractError("INVALID_METADATA")
    contract = catalog.get_contract(contract_id)
    present = input is not MISSING
    if contract.input.presence == "none" and present and input_representation_id is not None:
        raise ContractError(
            "REPRESENTATION_NOT_SUPPORTED",
            ErrorContext(contract_id=contract_id, direction="input"),
        )
    if (contract.input.presence == "required" and not present) or (
        contract.input.presence == "none" and present
    ):
        raise ContractError(
            "PAYLOAD_PRESENCE_VIOLATION",
            ErrorContext(
                contract_id=contract_id,
                direction="input",
            ),
        )
    if not present and input_representation_id is not None:
        raise ContractError("INVALID_METADATA")

    def sole(direction: str) -> str:
        candidates = catalog.capabilities(
            contract_id, cast("Literal['input', 'output']", direction)
        )
        choices = [item.representation.id for item in candidates if item.supported]
        if not choices:
            raise ContractError("REPRESENTATION_NOT_SUPPORTED")
        if len(choices) != 1:
            raise ContractError("AMBIGUOUS_SELECTION")
        return choices[0]

    selected_input = None
    input_id = None
    if present:
        input_id = input_representation_id if input_representation_id is not None else sole("input")
        selected_input = JsonDocument(
            catalog.select(contract_id, "input", input_id).validate(input)
        )
    accepted = accepted_output_representation_ids
    if contract.output.presence == "none":
        if accepted is not None:
            raise ContractError("INVALID_METADATA")
    elif accepted is None and allow_server_selection:
        if not any(item.supported for item in catalog.capabilities(contract_id, "output")):
            raise ContractError("REPRESENTATION_NOT_SUPPORTED")
    elif accepted is None:
        accepted = (sole("output"),)
    else:
        if (
            type(accepted) not in (tuple, list)
            or not accepted
            or any(type(item) is not str for item in accepted)
            or len(set(accepted)) != len(accepted)
        ):
            raise ContractError("INVALID_STRUCTURE")
        available = {
            item.representation.id
            for item in catalog.capabilities(contract_id, "output")
            if item.supported
        }
        if any(identifier not in available for identifier in accepted):
            raise ContractError("REPRESENTATION_NOT_SUPPORTED")
    return SelectedInvocation(
        contract_id, selected_input, input_id, tuple(accepted) if accepted is not None else None
    )


def bind_skill(
    catalog: ContractCatalog, skills: object, skill_id: str, contract_id: str | None = None
) -> Contract:
    matches = [
        item for item in describe_contracts(catalog, skills).skills if item.skill.id == skill_id
    ]
    if not matches:
        raise ContractError("CONTRACT_NOT_FOUND")
    contracts = matches[0].contracts
    if contract_id is not None:
        contracts = tuple(item for item in contracts if item.contract.id == contract_id)
    if not contracts:
        raise ContractError("CONTRACT_NOT_FOUND")
    if len(contracts) != 1:
        raise ContractError("AMBIGUOUS_SELECTION")
    return contracts[0].contract
