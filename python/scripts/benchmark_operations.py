"""Repeatable installed-artifact workloads; stdout is a machine-readable receipt.

Run outside the checkout using the noneditable wheel. Two arguments supply the
test-only loopback certificate/key. No model, credentials or network service.
"""

import asyncio
import base64
import hashlib
import json
import platform
import ssl
import statistics
import sys
import time
from collections.abc import Callable
from pathlib import Path

from a2a_schema_contract.catalog import parse_catalog
from a2a_schema_contract.core import JSON_SCHEMA_DIALECT, ContractError, JsonValue
from a2a_schema_contract.operations import ValidationSession
from a2a_schema_contract.resolver import ContractResolver

SCHEMA = {
    "type": "object",
    "required": ["count"],
    "additionalProperties": False,
    "properties": {"count": {"type": "integer", "minimum": 0, "maximum": 100}},
}
VALUE: dict[str, JsonValue] = {"count": 2}
CATALOG = {
    "contracts": [
        {
            "id": "urn:benchmark:1",
            "input": {
                "presence": "required",
                "representations": [
                    {
                        "id": "json",
                        "mediaType": "application/json",
                        "schema": {
                            "inline": SCHEMA,
                            "dialect": JSON_SCHEMA_DIALECT,
                            "mediaType": "application/schema+json",
                        },
                    }
                ],
            },
            "output": {"presence": "none"},
        }
    ]
}


def summary(samples: list[float]) -> dict[str, object]:
    return {
        "count": len(samples),
        "median_ms": statistics.median(samples),
        "max_ms": max(samples),
        "samples_ms": samples,
    }


def measure(action: Callable[[], object], count: int) -> dict[str, object]:
    samples: list[float] = []
    for _ in range(count):
        started = time.perf_counter()
        action()
        samples.append((time.perf_counter() - started) * 1000)
    return summary(samples)


async def benchmark(cert: Path, key: Path) -> dict[str, object]:
    cold = measure(
        lambda: parse_catalog(CATALOG).select("urn:benchmark:1", "input", "json").validate(VALUE),
        10,
    )
    validator = parse_catalog(CATALOG).select("urn:benchmark:1", "input", "json")

    def warm() -> None:
        for _ in range(1000):
            assert validator.validate(VALUE) == VALUE

    warm_batches = measure(warm, 10)
    arguments: dict[str, JsonValue] = {
        "contractId": "urn:benchmark:1",
        "direction": "input",
        "representationId": "json",
        "value": VALUE,
    }
    workers: list[float] = []
    async with ValidationSession(parse_catalog(CATALOG)) as session:
        for _ in range(5):
            started = time.perf_counter()
            assert await session.run("validate", arguments) == VALUE
            workers.append((time.perf_counter() - started) * 1000)
    server_tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_tls.load_cert_chain(cert, key)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    tls.load_verify_locations(cafile=str(cert))
    body = json.dumps(SCHEMA).encode()
    requests = 0

    async def serve(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        nonlocal requests
        try:
            await reader.readuntil(b"\r\n\r\n")
            requests += 1
            writer.write(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/schema+json\r\n"
                + f"Content-Length: {len(body)}\r\n\r\n".encode()
                + body
            )
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    listener = await asyncio.start_server(
        serve, "127.0.0.1", 0, ssl=server_tls, ssl_shutdown_timeout=0.1
    )
    origin = f"https://127.0.0.1:{listener.sockets[0].getsockname()[1]}"
    uri = origin + "/schema/v1.json"
    external = json.loads(json.dumps(CATALOG))
    external["contracts"][0]["input"]["representations"][0]["schema"] = {
        "uri": uri,
        "mediaType": "application/schema+json",
        "dialect": JSON_SCHEMA_DIALECT,
    }
    cold_https: list[float] = []
    warm_https: list[float] = []
    try:
        async with ContractResolver(
            tls=tls,
            allowed_origins=(origin,),
            allowed_addresses={"127.0.0.1": ("127.0.0.1",)},
            resource_integrity={
                uri: {
                    "algorithm": "sha-256",
                    "value": base64.b64encode(hashlib.sha256(body).digest()).decode(),
                }
            },
        ) as resolver:
            for _ in range(5):
                resolver.clear_cache()
                started = time.perf_counter()
                catalog = await resolver.resolve_catalog(external)
                cold_https.append((time.perf_counter() - started) * 1000)
                count = requests
                started = time.perf_counter()
                await resolver.resolve_catalog(external)
                warm_https.append((time.perf_counter() - started) * 1000)
                assert requests == count
                selected = catalog.select("urn:benchmark:1", "input", "json")
                assert selected.validate(VALUE) == VALUE
                try:
                    selected.validate({"count": True})
                except ContractError as error:
                    assert error.code == "INSTANCE_INVALID"
                else:
                    raise AssertionError("Boolean was coerced into an integer.")
    finally:
        listener.close()
        await listener.wait_closed()
    return {
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "machine": platform.machine(),
        "workload": "Node-matched count integer 0..100; 10 cold/10x1000 warm/5 fresh/5+5 HTTPS",
        "cold_compile": cold,
        "warm_1000_validations": warm_batches,
        "fresh_process_compile": summary(workers),
        "cold_pinned_https_prepare": summary(cold_https),
        "cached_pinned_https_prepare": summary(warm_https),
        "retrievals": requests,
        "cached_retrievals": 0,
        "result": "PASS",
    }


if __name__ == "__main__":
    print(json.dumps(asyncio.run(benchmark(Path(sys.argv[1]), Path(sys.argv[2]))), indent=2))
