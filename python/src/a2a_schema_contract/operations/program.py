"""Private JSON programs; no pickling, arbitrary callbacks or framework objects."""

from typing import TYPE_CHECKING, cast

from a2a_schema_contract.catalog import ContractCatalog, PreparedRepresentation
from a2a_schema_contract.core import Direction, JsonValue, Origin
from a2a_schema_contract.core.media import media
from a2a_schema_contract.core.models import (
    AbsentPayload,
    Invocation,
    JsonDocument,
    Payload,
    PreparedSchema,
    PresentPayload,
    SchemaResource,
)


def catalog_packet(catalog: ContractCatalog) -> dict[str, JsonValue]:
    return {
        "value": catalog.value,
        "origin": catalog._origin,
        "resources": [
            {
                "contractId": cid,
                "direction": side,
                "representationId": rid,
                "entry": prepared.entry,
                "descriptor": prepared.descriptor.value,
                "documents": [
                    {"uri": doc.uri, "value": doc.value, "aliases": list(doc.aliases)}
                    for doc in prepared.documents
                ],
            }
            for cid, side, rid, prepared in catalog._prepared
        ],
    }


def load_catalog(packet: dict[str, JsonValue]) -> ContractCatalog:
    catalog = ContractCatalog(packet["value"], cast("Origin", packet["origin"]))
    prepared: list[tuple[str, Direction, str, PreparedSchema]] = []
    for raw in cast("list[dict[str, JsonValue]]", packet.get("resources", [])):
        documents = tuple(
            SchemaResource(
                cast("str", doc["uri"]),
                JsonDocument(doc["value"]),
                tuple(cast("list[str]", doc.get("aliases", []))),
            )
            for doc in cast("list[dict[str, JsonValue]]", raw["documents"])
        )
        prepared.append(
            (
                cast("str", raw["contractId"]),
                cast("Direction", raw["direction"]),
                cast("str", raw["representationId"]),
                PreparedSchema(
                    cast("str", raw["entry"]), JsonDocument(raw["descriptor"]), documents
                ),
            )
        )
    object.__setattr__(catalog, "_prepared", tuple(prepared))
    return catalog


def payload_packet(payload: Payload | None) -> JsonValue:
    if payload is None:
        return None
    if not payload.present:
        return {"present": False}
    return {
        "present": True,
        "value": payload.value,
        "representationId": payload.representation_id,
        "part": payload.part.value,
    }


def load_payload(packet: JsonValue) -> Payload | None:
    if packet is None:
        return None
    raw = cast("dict[str, JsonValue]", packet)
    if raw["present"] is False:
        return AbsentPayload()
    return PresentPayload(
        JsonDocument(raw["value"]), cast("str", raw["representationId"]), JsonDocument(raw["part"])
    )


def selection_packet(selection: "ContractSelection") -> dict[str, JsonValue]:
    return {
        "contractId": selection.invocation.contract_id,
        "inputRepresentationId": selection.invocation.input_representation_id,
        "acceptedOutputRepresentationIds": (
            list(selection.invocation.accepted_output_representation_ids)
            if selection.invocation.accepted_output_representation_ids is not None
            else None
        ),
        "input": payload_packet(selection.input),
        "outputRepresentationId": selection.output.representation.id if selection.output else None,
    }


def load_selection(catalog: ContractCatalog, packet: dict[str, JsonValue]) -> "ContractSelection":
    from a2a_schema_contract.binding import ContractSelection

    cid = cast("str", packet["contractId"])
    rid = cast("str | None", packet["outputRepresentationId"])
    output = None
    if rid is not None:
        rep = catalog._representation(cid, "output", rid, "remote")
        output = PreparedRepresentation(cid, "output", rep, media(rep.media_type), None)
    payload = load_payload(packet["input"])
    assert payload is not None
    ids = cast("list[str] | None", packet["acceptedOutputRepresentationIds"])
    return ContractSelection(
        Invocation(
            cid,
            cast("str | None", packet["inputRepresentationId"]),
            tuple(ids) if ids is not None else None,
        ),
        payload,
        output,
    )


if TYPE_CHECKING:
    from a2a_schema_contract.binding import ContractSelection
