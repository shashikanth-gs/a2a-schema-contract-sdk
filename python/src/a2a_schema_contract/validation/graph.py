"""Inspect native resources only at schema positions before offline registration."""

import re
from typing import cast
from urllib.parse import unquote, urldefrag, urljoin, urlsplit

from a2a_schema_contract.core import ContractError, ErrorContext, JsonValue, absolute_uri
from a2a_schema_contract.core.models import SchemaResource
from a2a_schema_contract.uri import canonical_http

from .profile import ARRAY_SCHEMAS, MAP_SCHEMAS, ONE_SCHEMA, inspect_schema


def absolute(value: str, base: str, context: ErrorContext) -> str:
    if re.search(r"[\s\\]|%(?![0-9a-fA-F]{2})", value):
        raise ContractError("SCHEMA_INVALID", context)
    result = urldefrag(base)[0] + value if value.startswith("#") else urljoin(base, value)
    try:
        result = canonical_http(result)
        valid = absolute_uri(result) and urlsplit(result).username is None
    except ValueError:
        valid = False
    if not valid:
        raise ContractError("SCHEMA_INVALID", context)
    return result


def location(uri: str, context: ErrorContext) -> str:
    document, fragment = urldefrag(uri)
    # Match the portable profile: an encoded initial slash is not a pointer.
    if fragment.lower().startswith("%2f"):
        raise ContractError("SCHEMA_INVALID", context)
    try:
        decoded = unquote(fragment, errors="strict")
    except UnicodeError:
        raise ContractError("SCHEMA_INVALID", context) from None
    return document + ("#" + decoded if decoded else "")


class SchemaGraph:
    def __init__(
        self,
        context: ErrorContext,
        *,
        documents: int = 32,
        references: int = 128,
        schemas: int = 256,
    ) -> None:
        self.context = context
        self.max_documents, self.max_references, self.max_schemas = documents, references, schemas
        self.documents: list[SchemaResource] = []
        self.identities: dict[str, JsonValue] = {}
        self.locations: set[str] = set()
        self.targets: list[str] = []
        self.anchors: dict[str, JsonValue] = {}
        self.schemas = self.references = 0

    def add(self, resource: SchemaResource) -> tuple[str, ...]:
        context = self.context
        if len(self.documents) >= self.max_documents:
            raise ContractError("RESOURCE_LIMIT", context)
        value = resource.value
        inspect_schema(value, context)
        refs: list[str] = []
        local: dict[str, JsonValue] = {}

        def walk(node: JsonValue, base: str, pointer: str, resource_pointer: str) -> None:
            self.schemas += 1
            if self.schemas > self.max_schemas:
                raise ContractError("RESOURCE_LIMIT", context)
            if isinstance(node, dict) and isinstance(node.get("$id"), str):
                base = absolute(cast("str", node["$id"]), base, context)
                if urldefrag(base)[1]:
                    raise ContractError("SCHEMA_INVALID", context)
                base = urldefrag(base)[0]
                if base in local or base in self.identities:
                    raise ContractError("SCHEMA_INVALID", context)
                local[base] = node
                resource_pointer = pointer
            for uri in (resource.uri, *resource.aliases):
                self.locations.add(location(uri + "#" + pointer, context))
            self.locations.add(location(base + "#" + pointer[len(resource_pointer) :], context))
            if not isinstance(node, dict):
                return
            for key in ("$anchor", "$dynamicAnchor"):
                if isinstance(node.get(key), str):
                    anchor = location(base + "#" + cast("str", node[key]), context)
                    if anchor in self.anchors and self.anchors[anchor] is not node:
                        raise ContractError("SCHEMA_INVALID", context)
                    self.anchors[anchor] = node
                    self.locations.add(anchor)
                    if not resource_pointer:
                        for uri in (resource.uri, *resource.aliases):
                            self.locations.add(
                                location(uri + "#" + cast("str", node[key]), context)
                            )
            for key in ("$ref", "$dynamicRef"):
                if isinstance(node.get(key), str):
                    self.references += 1
                    if self.references > self.max_references:
                        raise ContractError("RESOURCE_LIMIT", context)
                    target = absolute(cast("str", node[key]), base, context)
                    refs.append(urldefrag(target)[0])
                    self.targets.append(target)
            for key, child in node.items():
                if key in MAP_SCHEMAS and isinstance(child, dict):
                    for name, item in child.items():
                        token = name.replace("~", "~0").replace("/", "~1")
                        walk(item, base, pointer + "/" + key + "/" + token, resource_pointer)
                elif key in ONE_SCHEMA:
                    walk(child, base, pointer + "/" + key, resource_pointer)
                elif key in ARRAY_SCHEMAS and isinstance(child, list):
                    for index, item in enumerate(child):
                        walk(item, base, pointer + "/" + key + "/" + str(index), resource_pointer)

        walk(value, resource.uri, "", "")
        for uri in (resource.uri, *resource.aliases):
            if uri in self.identities or (uri in local and local[uri] is not value):
                raise ContractError("SCHEMA_INVALID", context)
        self.identities.update(local)
        for uri in (resource.uri, *resource.aliases):
            self.identities[uri] = value
        self.documents.append(resource)
        return tuple(dict.fromkeys(refs))

    def finish(self, entry: str) -> None:
        for target in (entry, *self.targets):
            if location(target, self.context) not in self.locations:
                raise ContractError("SCHEMA_INVALID", self.context)


def inspect_graph(documents: tuple[SchemaResource, ...], entry: str, context: ErrorContext) -> None:
    graph = SchemaGraph(context)
    for resource in documents:
        graph.add(resource)
    graph.finish(entry)
