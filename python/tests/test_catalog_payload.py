"""Catalog and payload semantics, including all remaining shared Node profile cases."""

import json
from pathlib import Path
from typing import Literal, cast

import pytest

from a2a_schema_contract.catalog import create_contract_extension, parse_catalog, parse_extension
from a2a_schema_contract.core import EXTENSION_URI, ContractError, JsonValue
from a2a_schema_contract.core.models import AbsentPayload, InvocationSelection, JsonDocument
from a2a_schema_contract.discovery import bind_skill, describe_contracts, select_invocation
from a2a_schema_contract.payload import (
    CarrierProfile,
    decode_primary,
    encode_primary,
    guard_part,
    validate_invocation,
    validate_result,
)

from .inline_support import ID, as_dict, catalog

CASES = cast(
    "list[dict[str, JsonValue]]",
    json.loads((Path(__file__).parent / "fixtures/inline-core-cases.json").read_text())["cases"],
)


@pytest.mark.parametrize(
    "case",
    [case for case in CASES if case["operation"] != "validate"],
    ids=lambda case: str(case["id"]),
)
def test_shared_encoding_and_presence(case: dict[str, JsonValue]) -> None:
    raw = catalog(
        cast("Literal['required', 'optional', 'none']", case.get("presence", "required")),
        schema=case.get("schema", True),
    )
    as_dict(cast("list[JsonValue]", raw["contracts"])[0])["id"] = "urn:example:contract:test:1"
    parsed = parse_catalog(raw)
    carrier = cast("CarrierProfile", case.get("carrier", "json"))

    def operation() -> object:
        if case["operation"] == "encode":
            return encode_primary(
                parsed.select("urn:example:contract:test:1", "input", "json"),
                case["value"],
                carrier,
            )
        return decode_primary(
            parsed,
            "urn:example:contract:test:1",
            "input",
            case["parts"],
            cast("str | None", case.get("representationId")),
            carrier,
        )

    expected = as_dict(case["expected"])
    before = json.dumps(case, sort_keys=True)
    if expected["accepted"]:
        operation()
    else:
        with pytest.raises(ContractError) as caught:
            operation()
        assert caught.value.code == expected["diagnostic"]
    assert json.dumps(case, sort_keys=True) == before


def test_immutable_views_and_original_descriptor() -> None:
    raw = catalog(schema={"pattern": "^a$", "default": "a"})
    parsed = parse_catalog(raw)
    raw.clear()
    copy = as_dict(parsed.value)
    copy.clear()
    assert parsed.get_contract(ID).direction("output").presence == "required"
    assert parsed.get_contract(ID).direction("input").presence == "required"
    with pytest.raises(ContractError, match="INVALID_STRUCTURE"):
        parsed.get_contract(ID).direction(cast("Literal['input']", "bad"))
    with pytest.raises(ContractError, match="INVALID_STRUCTURE"):
        parsed.get_contract(ID).direction(cast("Literal['input']", None))
    prepared = parsed.schema(ID, "input", "json")
    assert prepared is not None
    assert prepared.documents[0].value == {"pattern": "^a$", "default": "a"}
    descriptor = as_dict(prepared.descriptor.value)
    as_dict(descriptor["inline"]).clear()
    assert as_dict(prepared.descriptor.value)["inline"] == {"pattern": "^a$", "default": "a"}
    assert parsed.select(ID, "input", "json").validate("a") == "a"
    assert parse_extension(create_contract_extension(parsed)).value == parsed.value
    assert JsonDocument(None).value is None


@pytest.mark.parametrize(
    "mutate,code",
    [
        ("invalid-id", "INVALID_IDENTIFIER"),
        ("supersedes", "INVALID_IDENTIFIER"),
        ("duplicate-contract", "DUPLICATE_IDENTIFIER"),
        ("duplicate-rep", "DUPLICATE_IDENTIFIER"),
        ("structure", "INVALID_STRUCTURE"),
    ],
)
def test_catalog_semantic_rejections(mutate: str, code: str) -> None:
    raw = catalog()
    contracts = cast("list[JsonValue]", raw["contracts"])
    contract = as_dict(contracts[0])
    if mutate == "invalid-id":
        contract["id"] = "urn:example:latest"
    elif mutate == "supersedes":
        contract["supersedes"] = ["urn:example:latest"]
    elif mutate == "duplicate-contract":
        contracts.append(contract)
    elif mutate == "duplicate-rep":
        reps = cast("list[JsonValue]", as_dict(contract["input"])["representations"])
        reps.append(reps[0])
    else:
        contract["extra"] = True
    with pytest.raises(ContractError, match=code):
        parse_catalog(raw)


@pytest.mark.parametrize(
    "mutate,code",
    [
        ("dialect", "UNSUPPORTED_DIALECT"),
        ("media", "UNSUPPORTED_MEDIA_TYPE"),
        ("external", "SCHEMA_UNAVAILABLE"),
        ("payload-media", "UNSUPPORTED_MEDIA_TYPE"),
        ("keyword", "UNSUPPORTED_KEYWORD"),
    ],
)
def test_unsupported_alternatives_are_visible_not_silently_selected(mutate: str, code: str) -> None:
    raw = catalog()
    rep = as_dict(
        cast(
            "list[JsonValue]",
            as_dict(as_dict(cast("list[JsonValue]", raw["contracts"])[0])["input"])[
                "representations"
            ],
        )[0]
    )
    descriptor = as_dict(rep["schema"])
    if mutate == "dialect":
        descriptor["dialect"] = "https://example.org/dialect/1"
    elif mutate == "media":
        descriptor["mediaType"] = "application/example+json"
    elif mutate == "external":
        del descriptor["inline"]
        descriptor["uri"] = "https://example.org/schema/1"
    elif mutate == "payload-media":
        rep["mediaType"] = "application/octet-stream"
    else:
        descriptor["inline"] = {"exampleAssertion": True}
    parsed = parse_catalog(raw)
    capability = parsed.capabilities(ID, "input")[0]
    assert not capability.supported and capability.diagnostic == code
    with pytest.raises(ContractError) as caught:
        parsed.select(ID, "input", "json", "remote")
    assert caught.value.code == code
    assert caught.value.origin == "remote"


def test_no_schema_text_and_input_payload_snapshots() -> None:
    raw = catalog(media="text/plain")
    rep = as_dict(
        cast(
            "list[JsonValue]",
            as_dict(as_dict(cast("list[JsonValue]", raw["contracts"])[0])["input"])[
                "representations"
            ],
        )[0]
    )
    del rep["schema"]
    parsed = parse_catalog(raw)
    assert parsed.schema(ID, "input", "json") is None
    selected = parsed.select(ID, "input", "json")
    part = encode_primary(selected, "")
    payload = decode_primary(parsed, ID, "input", [part], "json")
    assert payload.present and payload.value == ""
    assert payload.part.value == part
    with pytest.raises(ContractError, match="INVALID_CARRIER"):
        selected.validate({})


@pytest.mark.parametrize(
    "part",
    [
        None,
        {},
        {"text": "", "data": None},
        {"text": 1},
        {"text": "", "filename": None},
        {"data": {}, "metadata": []},
        {"url": "/x"},
        {"raw": "a"},
        {"raw": "YR=="},
        {"raw": "é"},
        {"text": "", "unknown": True},
    ],
)
def test_part_original_values_guarded(part: object) -> None:
    with pytest.raises(ContractError):
        guard_part(part)


def test_raw_url_companions_and_python_root_null() -> None:
    assert guard_part({"raw": "YQ=="})["raw"] == "YQ=="
    assert guard_part({"url": "https://example.org/resource"})["url"]
    parsed = parse_catalog(catalog())
    primary = encode_primary(parsed.select(ID, "input", "json"), None, "a2a-python-1.2.2")
    payload = decode_primary(
        parsed, ID, "input", [primary, {"raw": ""}], "json", "a2a-python-1.2.2"
    )
    assert payload.present and payload.value is None
    with pytest.raises(ContractError, match="UNSUPPORTED_CARRIER"):
        guard_part(primary, carrier="a2a-js-1.3.0")


def test_skill_discovery_stale_and_ambiguous_associations() -> None:
    raw = catalog()
    contracts = cast("list[JsonValue]", raw["contracts"])
    second = as_dict(JsonDocument(contracts[0]).value)
    second["id"] = "urn:example:contract:echo:2"
    contracts.append(second)
    third = as_dict(JsonDocument(second).value)
    third["id"] = "urn:example:contract:echo:3"
    third["skillIds"] = []
    contracts.append(third)
    parsed = parse_catalog(raw)
    skills = [{"id": "echo", "name": "Echo", "description": "Test"}]
    assert len(describe_contracts(parsed, skills).skills[0].contracts) == 2
    assert len(describe_contracts(parsed).stale_associations) == 2
    assert len(describe_contracts(parsed).unassociated) == 1
    with pytest.raises(ContractError, match="AMBIGUOUS_SELECTION"):
        bind_skill(parsed, skills, "echo")
    assert bind_skill(parsed, skills, "echo", ID).id == ID
    for skill_id, contract_id in [("missing", None), ("echo", "urn:example:contract:missing:1")]:
        with pytest.raises(ContractError, match="CONTRACT_NOT_FOUND"):
            bind_skill(parsed, skills, skill_id, contract_id)
    with pytest.raises(ContractError, match="DUPLICATE_IDENTIFIER"):
        describe_contracts(parsed, [*skills, *skills])


@pytest.mark.parametrize(
    "skills",
    [
        None,
        {},
        [None],
        [{"id": ""}],
        [{"id": "echo", "name": None}],
        [{"id": "echo", "description": 1}],
    ],
)
def test_malformed_skills_rejected(skills: object) -> None:
    with pytest.raises(ContractError):
        describe_contracts(parse_catalog(catalog()), skills)


def test_selection_presence_and_metadata() -> None:
    parsed = parse_catalog(catalog("optional", "none"))
    absent = select_invocation(parsed, ID)
    assert absent.input is None and absent.accepted_output_representation_ids is None
    assert select_invocation(parsed, ID, input=None).input is not None
    with pytest.raises(ContractError, match="INVALID_METADATA"):
        select_invocation(parsed, ID, input_representation_id="json")
    with pytest.raises(ContractError, match="INVALID_METADATA"):
        select_invocation(parsed, ID, accepted_output_representation_ids=["json"])
    required = parse_catalog(catalog())
    with pytest.raises(ContractError, match="PAYLOAD_PRESENCE_VIOLATION"):
        select_invocation(required, ID)
    none = parse_catalog(catalog("none", "none"))
    with pytest.raises(ContractError, match="PAYLOAD_PRESENCE_VIOLATION"):
        select_invocation(none, ID, input={})
    with pytest.raises(ContractError, match="REPRESENTATION_NOT_SUPPORTED"):
        select_invocation(none, ID, input={}, input_representation_id="json")
    with pytest.raises(ContractError, match="REPRESENTATION_NOT_SUPPORTED"):
        select_invocation(required, ID, input={}, accepted_output_representation_ids=["missing"])
    for accepted in ([], ["json", "json"], [None]):
        with pytest.raises(ContractError, match="INVALID_STRUCTURE"):
            select_invocation(
                required,
                ID,
                input={},
                accepted_output_representation_ids=cast("list[str]", accepted),
            )
    primary = encode_primary(required.select(ID, "input", "json"), {})
    invocation = validate_invocation(
        required, {EXTENSION_URI: {"contractId": ID, "inputRepresentationId": "json"}}, [primary]
    )
    assert isinstance(invocation, InvocationSelection)
    assert invocation.input.present
    optional = parse_catalog(catalog("optional", "optional"))
    result = validate_result(optional, ID, {EXTENSION_URI: {"contractId": ID}}, [])
    assert isinstance(result, AbsentPayload)
    with pytest.raises(ContractError, match="INVALID_METADATA"):
        validate_invocation(required, {}, [primary])


def test_ambiguity_refused_for_input_and_output() -> None:
    raw = catalog()
    contract = as_dict(cast("list[JsonValue]", raw["contracts"])[0])
    for direction in ("input", "output"):
        reps = cast("list[JsonValue]", as_dict(contract[direction])["representations"])
        second = as_dict(JsonDocument(reps[0]).value)
        second["id"] = "json2"
        reps.append(second)
    parsed = parse_catalog(raw)
    with pytest.raises(ContractError, match="AMBIGUOUS_SELECTION"):
        select_invocation(parsed, ID, input={})
    with pytest.raises(ContractError, match="AMBIGUOUS_SELECTION"):
        select_invocation(parsed, ID, input={}, input_representation_id="json")
    assert select_invocation(
        parsed,
        ID,
        input={},
        input_representation_id="json",
        accepted_output_representation_ids=["json2"],
    ).accepted_output_representation_ids == ("json2",)


@pytest.mark.parametrize(
    "value,code",
    [
        (None, "INVALID_STRUCTURE"),
        ({"uri": "urn:other:1"}, "VERSION_MISMATCH"),
        ({"uri": EXTENSION_URI, "required": None}, "INVALID_STRUCTURE"),
        (
            {
                "uri": EXTENSION_URI,
                "params": {
                    "catalog": {
                        "uri": "https://example.org/catalog/1",
                        "mediaType": "application/json",
                    }
                },
            },
            "SCHEMA_UNAVAILABLE",
        ),
    ],
)
def test_extension_failures(value: object, code: str) -> None:
    with pytest.raises(ContractError, match=code):
        parse_extension(value)
