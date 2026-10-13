"""Catalog application service: validated structures and explicit representation selection."""

import hashlib
import json
from dataclasses import dataclass
from typing import Literal, cast

from .core import (
    EXTENSION_URI,
    JSON_SCHEMA_DIALECT,
    ContractError,
    Direction,
    ErrorContext,
    JsonValue,
    Origin,
    Presence,
    versioned_id,
)
from .core.media import media
from .core.models import (
    Capability,
    Contract,
    ContractDirection,
    JsonDocument,
    PreparedSchema,
    Representation,
    SchemaResource,
)
from .ports import SchemaValidator
from .validation import JsonSchemaEngine, validate_structure


@dataclass(frozen=True, slots=True)
class PreparedRepresentation:
    contract_id: str
    direction: Direction
    representation: Representation
    codec: Literal["json", "text"]
    _validator: SchemaValidator | None

    def validate(self, value: object, origin: Origin = "local") -> JsonValue:
        from .core import snapshot

        context = ErrorContext(origin, self.contract_id, self.direction, self.representation.id)
        copy = snapshot(value, context)
        if self.codec == "text" and not isinstance(copy, str):
            raise ContractError("INVALID_CARRIER", context)
        return self._validator.validate(copy, context) if self._validator is not None else copy


@dataclass(frozen=True, slots=True, init=False)
class ContractCatalog:
    contracts: tuple[Contract, ...]
    _document: JsonDocument
    _origin: Origin
    _prepared: tuple[tuple[str, Direction, str, PreparedSchema], ...]
    _support: tuple[tuple[str, Direction, str, str | None], ...] | None

    def __init__(self, value: object, origin: Origin = "local") -> None:
        context = ErrorContext(origin)
        data = cast("dict[str, JsonValue]", validate_structure("catalog", value, context))
        contracts: list[Contract] = []
        seen: set[str] = set()
        for raw in cast("list[dict[str, JsonValue]]", data["contracts"]):
            identifier = cast("str", raw["id"])
            supersedes = tuple(cast("list[str]", raw.get("supersedes", [])))
            if not versioned_id(identifier) or any(not versioned_id(item) for item in supersedes):
                raise ContractError("INVALID_IDENTIFIER", context)
            if identifier in seen:
                raise ContractError("DUPLICATE_IDENTIFIER", context)
            seen.add(identifier)
            directions: list[ContractDirection] = []
            for name in ("input", "output"):
                spec = cast("dict[str, JsonValue]", raw[name])
                representations: list[Representation] = []
                ids: set[str] = set()
                for rep in cast("list[dict[str, JsonValue]]", spec.get("representations", [])):
                    rep_id = cast("str", rep["id"])
                    if rep_id in ids:
                        raise ContractError("DUPLICATE_IDENTIFIER", context)
                    ids.add(rep_id)
                    representations.append(
                        Representation(
                            rep_id,
                            cast("str", rep["mediaType"]),
                            cast("str | None", rep.get("description")),
                            JsonDocument(rep["schema"]) if "schema" in rep else None,
                        )
                    )
                directions.append(
                    ContractDirection(cast("Presence", spec["presence"]), tuple(representations))
                )
            contracts.append(
                Contract(
                    identifier,
                    directions[0],
                    directions[1],
                    cast("str | None", raw.get("description")),
                    tuple(cast("list[str]", raw.get("skillIds", []))),
                    supersedes,
                )
            )
        object.__setattr__(self, "contracts", tuple(contracts))
        object.__setattr__(self, "_document", JsonDocument(data))
        object.__setattr__(self, "_origin", origin)
        object.__setattr__(self, "_prepared", ())
        object.__setattr__(self, "_support", None)

    @property
    def value(self) -> JsonValue:
        return self._document.value

    def get_contract(self, identifier: str, origin: Origin | None = None) -> Contract:
        context = ErrorContext(origin or self._origin)
        if not versioned_id(identifier):
            raise ContractError("INVALID_IDENTIFIER", context)
        for contract in self.contracts:
            if contract.id == identifier:
                return contract
        raise ContractError("CONTRACT_NOT_FOUND", ErrorContext(context.origin, identifier))

    def _representation(
        self,
        contract_id: str,
        direction: Direction,
        representation_id: str,
        origin: Origin,
    ) -> Representation:
        if direction not in ("input", "output"):
            raise ContractError("INVALID_STRUCTURE", ErrorContext(origin))
        for rep in self.get_contract(contract_id, origin).direction(direction).representations:
            if rep.id == representation_id:
                return rep
        raise ContractError(
            "REPRESENTATION_NOT_SUPPORTED",
            ErrorContext(origin, contract_id, direction, representation_id),
        )

    def schema(
        self,
        contract_id: str,
        direction: Direction,
        representation_id: str,
        *,
        origin: Origin | None = None,
    ) -> PreparedSchema | None:
        source = origin or self._origin
        rep = self._representation(contract_id, direction, representation_id, source)
        context = ErrorContext(source, contract_id, direction, representation_id)
        if rep.schema is None:
            return None
        descriptor = cast("dict[str, JsonValue]", rep.schema.value)
        if descriptor.get("dialect") != JSON_SCHEMA_DIALECT:
            raise ContractError("UNSUPPORTED_DIALECT", context)
        if descriptor["mediaType"] != "application/schema+json":
            raise ContractError("UNSUPPORTED_MEDIA_TYPE", context)
        for identifier, side, name, prepared in self._prepared:
            if (identifier, side, name) == (contract_id, direction, representation_id):
                return prepared
        if "inline" not in descriptor:
            raise ContractError("SCHEMA_UNAVAILABLE", context)
        identity = json.dumps(
            [contract_id, direction, representation_id], ensure_ascii=False
        ).encode()
        entry = "urn:a2a-schema-contract:inline:" + hashlib.sha256(identity).hexdigest()
        return PreparedSchema(
            entry, rep.schema, (SchemaResource(entry, JsonDocument(descriptor["inline"])),)
        )

    def select(
        self,
        contract_id: str,
        direction: Direction,
        representation_id: str,
        origin: Origin | None = None,
    ) -> PreparedRepresentation:
        source = origin or self._origin
        rep = self._representation(contract_id, direction, representation_id, source)
        context = ErrorContext(source, contract_id, direction, representation_id)
        codec = media(rep.media_type, context)
        prepared = self.schema(contract_id, direction, representation_id, origin=source)
        validator = (
            JsonSchemaEngine().compile_prepared(prepared, context) if prepared is not None else None
        )
        return PreparedRepresentation(contract_id, direction, rep, codec, validator)

    def capabilities(self, contract_id: str, direction: Direction) -> tuple[Capability, ...]:
        if direction not in ("input", "output"):
            raise ContractError("INVALID_STRUCTURE", ErrorContext(self._origin))
        result: list[Capability] = []
        for rep in self.get_contract(contract_id).direction(direction).representations:
            if self._support is not None:
                from .core.errors import DiagnosticCode

                diagnostic = next(
                    code
                    for cid, side, rid, code in self._support
                    if (cid, side, rid) == (contract_id, direction, rep.id)
                )
                result.append(
                    Capability(rep, diagnostic is None, cast("DiagnosticCode", diagnostic))
                )
                continue
            try:
                self.select(contract_id, direction, rep.id)
                result.append(Capability(rep, True))
            except ContractError as error:
                result.append(Capability(rep, False, error.code))
        return tuple(result)


def parse_catalog(value: object, origin: Origin = "local") -> ContractCatalog:
    return ContractCatalog(value, origin)


def parse_extension(value: object, origin: Origin = "remote") -> ContractCatalog:
    from .core import snapshot

    context = ErrorContext(origin)
    data = snapshot(value, context)
    if not isinstance(data, dict) or not isinstance(data.get("uri"), str):
        raise ContractError("INVALID_STRUCTURE", context)
    if data["uri"] != EXTENSION_URI:
        raise ContractError("VERSION_MISMATCH", context)
    if "required" in data and type(data["required"]) is not bool:
        raise ContractError("INVALID_STRUCTURE", context)
    params = cast(
        "dict[str, JsonValue]", validate_structure("extension-params", data.get("params"), context)
    )
    catalog = cast("dict[str, JsonValue]", params["catalog"])
    if "inline" not in catalog:
        raise ContractError("SCHEMA_UNAVAILABLE", context)
    return parse_catalog(catalog["inline"], origin)


def create_contract_extension(catalog: ContractCatalog, *, required: bool = False) -> JsonValue:
    if type(required) is not bool:
        raise ContractError("INVALID_STRUCTURE")
    params = validate_structure("extension-params", {"catalog": {"inline": catalog.value}})
    return {
        "uri": EXTENSION_URI,
        "required": required,
        "description": "Schema Contract",
        "params": params,
    }
