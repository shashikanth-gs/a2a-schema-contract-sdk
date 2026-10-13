"""Owned subprocess lifecycle shared by DNS and validation, never shell execution."""

import asyncio
import contextlib
import json
import os
import sys
from pathlib import Path

from a2a_schema_contract.core import ContractError

PACKET_BYTES = 4194304


def environment() -> dict[str, str]:
    # Windows needs its system directory to start Python. No application secrets,
    # Python flags, proxy variables, HOME, user site or working-directory imports.
    return {name: os.environ[name] for name in ("SystemRoot", "WINDIR") if name in os.environ}


def bootstrap() -> str:
    import attrs
    import jsonschema
    import referencing
    import rpds
    import typing_extensions

    roots = {str(Path(__file__).resolve().parents[2])}
    for module in (attrs, jsonschema, referencing, rpds, typing_extensions):
        assert module.__file__ is not None
        path = Path(module.__file__).resolve()
        roots.add(str(path.parent if path.name == "typing_extensions.py" else path.parents[1]))
    return (
        "import sys; sys.path.extend(" + repr(sorted(roots)) + "); "
        "from a2a_schema_contract.operations.worker import main; main()"
    )


async def reap(process: asyncio.subprocess.Process) -> None:
    if process.returncode is None:
        with contextlib.suppress(ProcessLookupError):
            process.kill()
    await process.wait()


async def exchange(packet: bytes, *, dns: bool = False) -> bytes:
    if len(packet) > PACKET_BYTES:
        raise ContractError("RESOURCE_LIMIT")
    code = bootstrap()
    # Shield acquisition so cancellation during spawn cannot lose the handle.
    spawn = asyncio.create_task(
        asyncio.create_subprocess_exec(
            sys.executable,
            "-I",
            "-S",
            "-B",
            "-c",
            code,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env=environment(),
            cwd=os.path.dirname(sys.executable),
            limit=65536,
        )
    )
    process = None
    try:
        process = await asyncio.shield(spawn)
        assert process.stdin is not None and process.stdout is not None

        async def write() -> None:
            assert process is not None and process.stdin is not None
            process.stdin.write(packet)
            await process.stdin.drain()
            process.stdin.close()

        writer = asyncio.create_task(write())
        try:
            output = bytearray()
            while block := await process.stdout.read(65536):
                output.extend(block)
                if len(output) > PACKET_BYTES:
                    raise ContractError("RESOURCE_LIMIT")
            await writer
            await process.wait()
            if process.returncode:
                raise ContractError("SCHEMA_UNAVAILABLE" if dns else "RESOURCE_LIMIT")
            return bytes(output)
        finally:
            writer.cancel()
            await asyncio.gather(writer, return_exceptions=True)
    finally:

        async def finish() -> None:
            owned = process if process is not None else await spawn
            await reap(owned)

        cleanup = asyncio.create_task(finish())
        while not cleanup.done():
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                continue
        await cleanup


def encode(packet: object) -> bytes:
    return json.dumps(packet, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()
