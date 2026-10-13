"""Explicit bounded resource resolution; validation never performs retrieval."""

import asyncio
import base64
import hashlib
import hmac
import ipaddress
import re
import ssl
import time
from collections import OrderedDict
from collections.abc import Mapping
from dataclasses import dataclass, fields
from types import MappingProxyType
from typing import Literal, cast
from urllib.parse import urldefrag, urljoin
from uuid import uuid4

from a2a_schema_contract.catalog import ContractCatalog
from a2a_schema_contract.core import (
    EXTENSION_URI,
    JSON_SCHEMA_DIALECT,
    ContractError,
    Direction,
    ErrorContext,
    JsonValue,
    Origin,
    loads,
    snapshot,
)
from a2a_schema_contract.core.errors import DiagnosticCode
from a2a_schema_contract.core.models import JsonDocument, PreparedSchema, SchemaResource
from a2a_schema_contract.operations import Diagnostic, DiagnosticHook, ValidationSession
from a2a_schema_contract.operations.diagnostics import observe
from a2a_schema_contract.validation import validate_structure
from a2a_schema_contract.validation.graph import SchemaGraph

from .network import Lookup, default_tls, retrieve, system_lookup
from .policy import resource_url


@dataclass(frozen=True, slots=True)
class ResolverLimits:
    redirects: int = 3
    response_bytes: int = 262144
    total_bytes: int = 1048576
    deadline: float = 10.0
    documents: int = 32
    references: int = 128
    schemas: int = 256
    reference_depth: int = 8
    cache_entries: int = 32
    cache_bytes: int = 1048576
    concurrent: int = 4

    def __post_init__(self) -> None:
        maxima = (3, 262144, 1048576, 10, 32, 128, 256, 8, 32, 1048576, 4)
        for field, maximum in zip(fields(self), maxima, strict=True):
            value = getattr(self, field.name)
            minimum = 0 if field.name in ("redirects", "cache_entries", "cache_bytes") else 1
            if field.name == "deadline":
                valid = type(value) in (int, float) and 0 < value <= maximum
            else:
                valid = type(value) is int and minimum <= value <= maximum
            if not valid:
                raise ValueError("Invalid resolver limit.")


@dataclass(frozen=True, slots=True)
class CacheInfo:
    entries: int
    bytes: int


@dataclass(frozen=True, slots=True)
class _Cached:
    body: bytes
    uri: str


def _pin(value: object, context: ErrorContext) -> tuple[str, bytes, str]:
    copied = snapshot(value, context)
    if not isinstance(copied, dict) or set(copied) != {"algorithm", "value"}:
        raise ContractError("INVALID_STRUCTURE", context)
    algorithm, encoded = copied["algorithm"], copied["value"]
    if algorithm not in ("sha-256", "sha-512") or not isinstance(encoded, str):
        raise ContractError("INVALID_STRUCTURE", context)
    try:
        digest = base64.b64decode(encoded, validate=True)
    except ValueError:
        raise ContractError("INVALID_STRUCTURE", context) from None
    if (
        len(digest) != (32 if algorithm == "sha-256" else 64)
        or base64.b64encode(digest).decode() != encoded
    ):
        raise ContractError("INVALID_STRUCTURE", context)
    return algorithm, digest, encoded


DEFAULT_LIMITS = ResolverLimits()


class ContractResolver:
    """One authentication/security identity owns one resolver and its private cache.

    Custom lookup callbacks must cooperate with task cancellation. The default
    DNS implementation owns a disposable process and physically reaps it.
    """

    def __init__(
        self,
        *,
        allowed_origins: tuple[str, ...] | None = None,
        allowed_addresses: Mapping[str, tuple[str, ...]] | None = None,
        authorization: Mapping[str, str] | None = None,
        immutable_resources: tuple[str, ...] = (),
        resource_integrity: Mapping[str, object] | None = None,
        lookup: Lookup = system_lookup,
        tls: ssl.SSLContext | None = None,
        limits: ResolverLimits = DEFAULT_LIMITS,
        diagnostics: DiagnosticHook | None = None,
    ) -> None:
        self.limits, self.diagnostics = limits, diagnostics

        def origin(value: str) -> str:
            parsed = resource_url(value)
            if parsed.origin != value:
                raise ValueError("Expected an exact HTTPS origin.")
            return value

        self._origins = (
            None if allowed_origins is None else frozenset(origin(v) for v in allowed_origins)
        )
        auth = dict(authorization or {})
        for key, value in auth.items():
            origin(key)
            if type(value) is not str or not value or re.search(r"[^\x20-\x7e]", value):
                raise ValueError("Invalid origin authorization.")
        self._authorization = MappingProxyType(auth)
        addresses = dict(allowed_addresses or {})
        for key, values in addresses.items():
            authority = "[" + key + "]" if ":" in key else key
            if resource_url("https://" + authority).hostname != key or type(values) is not tuple:
                raise ValueError("Invalid exact host/address override.")
            if not values or any("%" in v or str(ipaddress.ip_address(v)) != v for v in values):
                raise ValueError("Invalid exact host/address override.")
        self._addresses = MappingProxyType(addresses)

        def document(value: str) -> str:
            parsed = resource_url(value)
            if parsed.value != parsed.document:
                raise ValueError("Expected a fragmentless resource URI.")
            return parsed.document

        self._immutable = frozenset(document(v) for v in immutable_resources)
        self._pins = MappingProxyType(
            {document(k): _pin(v, ErrorContext()) for k, v in (resource_integrity or {}).items()}
        )
        self._lookup = lookup
        self._tls = default_tls() if tls is None else tls
        if self._tls.verify_mode != ssl.CERT_REQUIRED or not self._tls.check_hostname:
            raise ValueError("Certificate and hostname verification are required.")
        self._cache: OrderedDict[tuple[str, str, str, str], _Cached] = OrderedDict()
        self._cache_bytes = 0
        self._jobs: set[asyncio.Task[object]] = set()
        self._closed = False

    @property
    def cache(self) -> CacheInfo:
        return CacheInfo(len(self._cache), self._cache_bytes)

    def clear_cache(self) -> None:
        self._cache.clear()
        self._cache_bytes = 0

    async def resolve_catalog(self, value: object, *, origin: Origin = "remote") -> ContractCatalog:
        return await self._run(value, "catalog", origin)

    async def resolve_extension_params(
        self, value: object, *, origin: Origin = "remote"
    ) -> ContractCatalog:
        return await self._run(value, "params", origin)

    async def resolve_extension(
        self, value: object, *, origin: Origin = "remote"
    ) -> ContractCatalog:
        return await self._run(value, "extension", origin)

    async def _run(
        self, value: object, kind: Literal["catalog", "params", "extension"], origin: Origin
    ) -> ContractCatalog:
        context = ErrorContext(origin)
        if self._closed:
            raise ContractError("RESOLUTION_ABORTED", context)
        if len(self._jobs) >= self.limits.concurrent:
            raise ContractError("RESOURCE_LIMIT", context)
        task = asyncio.current_task()
        assert task is not None
        self._jobs.add(task)
        started, correlation = time.monotonic(), str(uuid4())
        code: DiagnosticCode | None = None
        outcome: Literal["accepted", "rejected", "aborted"] = "accepted"
        try:
            async with asyncio.timeout(self.limits.deadline):
                return await self._prepare(value, kind, context)
        except TimeoutError:
            code, outcome = "RESOLUTION_TIMEOUT", "rejected"
            raise ContractError(code, context) from None
        except asyncio.CancelledError:
            code, outcome = "RESOLUTION_ABORTED", "aborted"
            raise
        except ContractError as error:
            code, outcome = error.code, "rejected"
            raise
        except Exception:
            code, outcome = "SCHEMA_UNAVAILABLE", "rejected"
            raise ContractError(code, context) from None
        finally:
            self._jobs.discard(task)
            observe(
                self.diagnostics,
                Diagnostic(
                    "resolution", correlation, (time.monotonic() - started) * 1000, outcome, code
                ),
            )

    async def _prepare(self, value: object, kind: str, context: ErrorContext) -> ContractCatalog:
        limits = self.limits
        acquired: dict[tuple[str, str], _Cached] = {}
        decoded: dict[tuple[str, str], SchemaResource] = {}
        total_bytes = 0

        async def get(
            uri: str, media_type: str, declared: object = None, require_immutable: bool = False
        ) -> SchemaResource:
            nonlocal total_bytes
            requested = resource_url(uri, context)
            if media_type == "application/json" and urldefrag(requested.value)[1]:
                raise ContractError("RESOLUTION_POLICY", context)
            configured = self._pins.get(requested.document)
            pin = _pin(declared, context) if declared is not None else configured
            if declared is not None and configured is not None and pin != configured:
                raise ContractError("INTEGRITY_MISMATCH", context)
            reusable = pin is not None or requested.document in self._immutable
            if require_immutable and not reusable:
                raise ContractError("RESOLUTION_POLICY", context)
            key = (requested.document, media_type, pin[0] if pin else "", pin[2] if pin else "")
            namespace = (requested.document, media_type)
            existing = acquired.get(namespace)
            if existing is None and len(acquired) >= limits.documents:
                raise ContractError("RESOURCE_LIMIT", context)
            stored = existing or self._cache.get(key)
            if key in self._cache:
                self._cache.move_to_end(key)
            if stored is None:
                visited: set[str] = set()
                url = requested
                authorization_origin = url.origin
                for redirects in range(limits.redirects + 1):
                    if url.document in visited:
                        raise ContractError("REFERENCE_CYCLE", context)
                    visited.add(url.document)
                    response = await retrieve(
                        url,
                        lookup=self._lookup,
                        allowed_origins=self._origins,
                        allowed_addresses=self._addresses,
                        authorization=self._authorization.get(url.origin)
                        if authorization_origin == url.origin
                        else None,
                        tls=self._tls,
                        maximum=limits.response_bytes,
                        context=context,
                    )
                    if response.status in (301, 302, 303, 307, 308):
                        if redirects >= limits.redirects:
                            raise ContractError("RESOURCE_LIMIT", context)
                        target = response.headers.get("location")
                        if target is None:
                            raise ContractError("SCHEMA_UNAVAILABLE", context)
                        if re.search(r"[\s\\]|%(?![0-9a-fA-F]{2})", target):
                            raise ContractError("RESOLUTION_POLICY", context)
                        next_url = resource_url(urljoin(url.document, target), context)
                        if next_url.origin != url.origin:
                            authorization_origin = ""
                        url = next_url
                        continue
                    content_type = re.sub(
                        r"\s", "", response.headers.get("content-type", "").lower()
                    )
                    if content_type not in (
                        media_type,
                        media_type + ";charset=utf-8",
                        media_type + ';charset="utf-8"',
                    ):
                        raise ContractError("UNSUPPORTED_MEDIA_TYPE", context)
                    stored = _Cached(response.body, url.document)
                    break
            assert stored is not None
            if existing is None:
                total_bytes += len(stored.body)
                if total_bytes > limits.total_bytes:
                    raise ContractError("RESOURCE_LIMIT", context)
            if pin is not None and not hmac.compare_digest(
                hashlib.new(pin[0].replace("-", ""), stored.body).digest(), pin[1]
            ):
                raise ContractError("INTEGRITY_MISMATCH", context)
            if namespace not in decoded:
                data = loads(stored.body, context)
                aliases = (requested.document,) if requested.document != stored.uri else ()
                decoded[namespace] = SchemaResource(stored.uri, JsonDocument(data), aliases)
            acquired[namespace] = stored
            if (
                reusable
                and key not in self._cache
                and limits.cache_entries
                and len(stored.body) <= limits.cache_bytes
            ):
                while (
                    len(self._cache) >= limits.cache_entries
                    or self._cache_bytes + len(stored.body) > limits.cache_bytes
                ):
                    _, oldest = self._cache.popitem(last=False)
                    self._cache_bytes -= len(oldest.body)
                self._cache[key] = stored
                self._cache_bytes += len(stored.body)
            return decoded[namespace]

        data = snapshot(value, context)
        if kind == "extension":
            if not isinstance(data, dict) or not isinstance(data.get("uri"), str):
                raise ContractError("INVALID_STRUCTURE", context)
            if data["uri"] != EXTENSION_URI:
                raise ContractError("VERSION_MISMATCH", context)
            if "required" in data and type(data["required"]) is not bool:
                raise ContractError("INVALID_STRUCTURE", context)
            data = data.get("params")
        if kind != "catalog":
            params = cast(
                "dict[str, JsonValue]", validate_structure("extension-params", data, context)
            )
            descriptor = cast("dict[str, JsonValue]", params["catalog"])
            data = (
                descriptor["inline"]
                if "inline" in descriptor
                else (
                    await get(
                        cast("str", descriptor["uri"]),
                        "application/json",
                        descriptor.get("integrity"),
                        True,
                    )
                ).value
            )
        catalog = ContractCatalog(data, context.origin)
        prepared: list[tuple[str, Direction, str, PreparedSchema]] = []
        async with ValidationSession(diagnostics=self.diagnostics) as session:
            for contract in catalog.contracts:
                for direction in ("input", "output"):
                    for rep in contract.direction(direction).representations:
                        if rep.schema is None:
                            continue
                        descriptor = cast("dict[str, JsonValue]", rep.schema.value)
                        if (
                            "bundle" in descriptor
                            or descriptor.get("dialect") != JSON_SCHEMA_DIALECT
                            or descriptor["mediaType"] != "application/schema+json"
                        ):
                            continue
                        scoped = ErrorContext(context.origin, contract.id, direction, rep.id)
                        if "inline" in descriptor:
                            root_view = catalog.schema(contract.id, direction, rep.id)
                            assert root_view is not None
                            root, entry = root_view.documents[0], root_view.entry
                        else:
                            root = await get(
                                cast("str", descriptor["uri"]),
                                "application/schema+json",
                                descriptor.get("integrity"),
                            )
                            entry = resource_url(cast("str", descriptor["uri"]), scoped).value
                        graph = SchemaGraph(
                            scoped,
                            documents=limits.documents,
                            references=limits.references,
                            schemas=limits.schemas,
                        )
                        visiting: set[str] = set()

                        async def add(
                            resource: SchemaResource,
                            depth: int,
                            *,
                            graph: SchemaGraph = graph,
                            scoped: ErrorContext = scoped,
                            visiting: set[str] = visiting,
                        ) -> None:
                            if depth > limits.reference_depth:
                                raise ContractError("RESOURCE_LIMIT", scoped)
                            old_ids = set(graph.identities)
                            refs = graph.add(resource)
                            identities = set(graph.identities) - old_ids
                            visiting.update(identities)
                            for dependency in refs:
                                if dependency in identities:
                                    continue
                                if dependency in visiting:
                                    raise ContractError("REFERENCE_CYCLE", scoped)
                                if dependency not in graph.identities:
                                    acquired_resource = await get(
                                        dependency, "application/schema+json"
                                    )
                                    if acquired_resource.uri in visiting:
                                        raise ContractError("REFERENCE_CYCLE", scoped)
                                    await add(acquired_resource, depth + 1)
                            visiting.difference_update(identities)

                        await add(root, 0)
                        graph.finish(entry)
                        schema = PreparedSchema(entry, rep.schema, tuple(graph.documents))
                        await session.run(
                            "compile",
                            {
                                "entry": entry,
                                "documents": [
                                    {
                                        "uri": doc.uri,
                                        "value": doc.value,
                                        "aliases": list(doc.aliases),
                                    }
                                    for doc in schema.documents
                                ],
                            },
                            context=scoped,
                        )
                        prepared.append((contract.id, direction, rep.id, schema))
        object.__setattr__(catalog, "_prepared", tuple(prepared))
        async with ValidationSession(catalog, diagnostics=self.diagnostics) as capabilities:
            support = cast("list[dict[str, JsonValue]]", await capabilities.run("capabilities", {}))
        object.__setattr__(
            catalog,
            "_support",
            tuple(
                (
                    cast("str", item["contractId"]),
                    cast("Direction", item["direction"]),
                    cast("str", item["representationId"]),
                    cast("str | None", item["code"]),
                )
                for item in support
            ),
        )
        return catalog

    async def close(self) -> None:
        self._closed = True
        jobs = tuple(self._jobs - {asyncio.current_task()})
        for task in jobs:
            task.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)
        self.clear_cache()

    async def __aenter__(self) -> "ContractResolver":
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()


__all__ = ["CacheInfo", "ContractResolver", "ResolverLimits"]
