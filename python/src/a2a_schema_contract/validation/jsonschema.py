"""Offline jsonschema/referencing infrastructure. No automatic reference retrieval."""

from dataclasses import dataclass
from typing import cast
from urllib.parse import urldefrag, urljoin

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError, ValidationError
from referencing import Registry, Resource
from referencing.exceptions import NoSuchResource, Unresolvable
from referencing.jsonschema import DRAFT202012, Schema

from a2a_schema_contract.core import ContractError, ErrorContext, JsonValue, snapshot
from a2a_schema_contract.core.errors import LOCAL_CONTEXT
from a2a_schema_contract.core.media import media
from a2a_schema_contract.core.models import PreparedSchema
from a2a_schema_contract.ports import SchemaValidator
from a2a_schema_contract.resources import SCHEMA_NAMES, SchemaName, read_schema

from .profile import ARRAY_SCHEMAS, MAP_SCHEMAS, ONE_SCHEMA, inspect_schema
from .projection import project_patterns, project_resources


@dataclass(frozen=True, slots=True)
class _Validator:
    _validator: Draft202012Validator

    def validate(self, value: object, context: ErrorContext = LOCAL_CONTEXT) -> JsonValue:
        copy = snapshot(value, context)
        try:
            self._validator.validate(copy)
        except ValidationError:
            raise ContractError("INSTANCE_INVALID", context) from None
        except Unresolvable:
            raise ContractError("SCHEMA_UNAVAILABLE", context) from None
        except RecursionError:
            raise ContractError("RESOURCE_LIMIT", context) from None
        return copy


class JsonSchemaEngine:
    """Trusted calling-thread validation; async boundaries use disposable worker budgets."""

    def compile_prepared(
        self, prepared: PreparedSchema, context: ErrorContext = LOCAL_CONTEXT
    ) -> SchemaValidator:
        """Use only explicitly inspected resources; the registry never retrieves."""
        from .graph import absolute, inspect_graph

        documents = [(item.uri, item.value) for item in prepared.documents]
        inspect_graph(prepared.documents, prepared.entry, context)
        registry: Registry[Schema] = Registry()
        projected = project_resources(
            documents, {doc.uri: doc.aliases for doc in prepared.documents}
        )
        for resource, (uri, value) in zip(prepared.documents, projected, strict=True):
            try:
                Draft202012Validator.check_schema(cast("Schema", value))
            except SchemaError:
                raise ContractError("SCHEMA_INVALID", context) from None
            if isinstance(value, dict):
                value = {
                    **value,
                    "$id": urldefrag(absolute(cast("str", value.get("$id", uri)), uri, context))[0],
                }
            native = DRAFT202012.create_resource(cast("Schema", value))
            registry = registry.with_resource(uri, native)
            for alias in resource.aliases:
                registry = registry.with_resource(alias, native)
        registry = registry.crawl()
        entry_uri, fragment = urldefrag(prepared.entry)
        for resource in prepared.documents:
            if entry_uri in (resource.uri, *resource.aliases):
                original = resource.value
                entry_uri = absolute(
                    cast("str", original.get("$id", resource.uri))
                    if isinstance(original, dict)
                    else resource.uri,
                    resource.uri,
                    context,
                )
                break
        entry = urldefrag(entry_uri)[0] + ("#" + fragment if fragment else "")
        try:
            registry.resolver().lookup(entry)

            def check(node: JsonValue, current: str) -> None:
                if not isinstance(node, dict):
                    return
                if isinstance(node.get("$id"), str):
                    current = absolute(cast("str", node["$id"]), current, context)
                for key, value in node.items():
                    if key in ("$ref", "$dynamicRef") and isinstance(value, str):
                        registry.resolver(current).lookup(value)
                    if key in MAP_SCHEMAS and isinstance(value, dict):
                        for child in value.values():
                            check(child, current)
                    elif key in ONE_SCHEMA:
                        check(value, current)
                    elif key in ARRAY_SCHEMAS and isinstance(value, list):
                        for child in value:
                            check(child, current)

            for uri, value in projected:
                check(value, uri)
        except Unresolvable:
            raise ContractError("SCHEMA_INVALID", context) from None
        return _Validator(Draft202012Validator({"$ref": entry}, registry=registry))

    def compile(
        self,
        schema: object,
        context: ErrorContext = LOCAL_CONTEXT,
    ) -> SchemaValidator:
        copy = snapshot(schema, context)
        inspect_schema(copy, context)
        try:
            Draft202012Validator.check_schema(cast("Schema", copy))
        except SchemaError:
            raise ContractError("SCHEMA_INVALID", context) from None
        typed = cast("Schema", copy)
        resource: Resource[Schema] = DRAFT202012.create_resource(typed)
        entry = "urn:a2a-schema-contract:inline:root"
        registry: Registry[Schema] = Registry().with_resource(entry, resource).crawl()
        base = copy.get("$id", entry) if isinstance(copy, dict) else entry
        if not isinstance(base, str):
            raise ContractError("SCHEMA_INVALID", context)

        def check_refs(node: JsonValue, current: str) -> None:
            if not isinstance(node, dict):
                return
            if isinstance(node.get("$id"), str):
                current = urljoin(current, cast("str", node["$id"]))
            for key, value in node.items():
                if key in ("$ref", "$dynamicRef") and isinstance(value, str):
                    try:
                        registry.resolver(current).lookup(value)
                    except (Unresolvable, NoSuchResource):
                        raise ContractError("SCHEMA_UNAVAILABLE", context) from None
                if key in MAP_SCHEMAS and isinstance(value, dict):
                    for child in value.values():
                        check_refs(child, current)
                elif key in ONE_SCHEMA:
                    check_refs(value, current)
                elif key in ARRAY_SCHEMAS and isinstance(value, list):
                    for child in value:
                        check_refs(child, current)

        check_refs(copy, base)
        compiled = cast("Schema", project_patterns(copy, entry))
        compiled_registry: Registry[Schema] = (
            Registry()
            .with_resource(
                entry,
                DRAFT202012.create_resource(compiled),
            )
            .crawl()
        )
        return _Validator(Draft202012Validator(compiled, registry=compiled_registry))


def validate_structure(
    name: SchemaName,
    value: object,
    context: ErrorContext = LOCAL_CONTEXT,
) -> JsonValue:
    """Validate pinned extension structures against installed offline resources."""
    copy = snapshot(value, context)
    registry: Registry[Schema] = Registry()
    schemas = {key: read_schema(key) for key in SCHEMA_NAMES}
    for schema in schemas.values():
        registry = registry.with_resource(
            cast("str", schema["$id"]),
            DRAFT202012.create_resource(cast("Schema", schema)),
        )
    try:
        Draft202012Validator(cast("Schema", schemas[name]), registry=registry).validate(copy)
    except (ValidationError, Unresolvable):
        raise ContractError("INVALID_STRUCTURE", context) from None
    return copy


def validate_value(
    value: object,
    *,
    schema: object = True,
    media_type: str = "application/json",
    context: ErrorContext = LOCAL_CONTEXT,
) -> JsonValue:
    """Calling-thread validation for a supported media representation."""
    codec = media(media_type, context)
    copy = snapshot(value, context)
    if codec == "text" and not isinstance(copy, str):
        raise ContractError("INVALID_CARRIER", context)
    return JsonSchemaEngine().compile(schema, context).validate(copy, context)
