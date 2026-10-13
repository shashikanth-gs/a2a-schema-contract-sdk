"""Conservative HTTPS/address policy matching the accepted Node security profile."""

import ipaddress
import re
from dataclasses import dataclass
from urllib.parse import SplitResult, urlsplit, urlunsplit

from a2a_schema_contract.core import ContractError, ErrorContext
from a2a_schema_contract.core.errors import LOCAL_CONTEXT
from a2a_schema_contract.uri import canonical_path


def public_address(value: str) -> bool:
    if "%" in value:
        return False
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv4Address):
        a, b, c, d = address.packed
        return not (
            a in (0, 10, 127)
            or a >= 224
            or (a, b, c, d) == (168, 63, 129, 16)
            or (a == 100 and 64 <= b <= 127)
            or (a == 169 and b == 254)
            or (a == 172 and 16 <= b <= 31)
            or (a == 192 and (b in (0, 168) or (b, c) == (88, 99)))
            or (a == 198 and (b in (18, 19) or (b, c) == (51, 100)))
            or (a, b, c) == (203, 0, 113)
        )
    first = int.from_bytes(address.packed[:2], "big")
    second = int.from_bytes(address.packed[2:4], "big")
    return first & 0xE000 == 0x2000 and not (
        (first == 0x2001 and (second < 0x200 or second == 0xDB8))
        or first == 0x2002
        or (first == 0x3FFF and second < 0x1000)
    )


@dataclass(frozen=True, slots=True)
class ResourceURL:
    value: str
    document: str
    origin: str
    hostname: str
    port: int
    target: str
    authority: str


def resource_url(value: str, context: ErrorContext = LOCAL_CONTEXT) -> ResourceURL:
    def refused() -> ContractError:
        return ContractError("RESOLUTION_POLICY", context)

    if (
        type(value) is not str
        or len(value) > 8192
        or re.search(r"[^\x21-\x7e]|\\|%(?![0-9a-fA-F]{2})", value)
    ):
        raise refused()
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        if (
            parsed.scheme.lower() != "https"
            or not host
            or parsed.username is not None
            or parsed.password is not None
            or host.endswith(".")
            or "%" in host
        ):
            raise refused()
        port = parsed.port if parsed.port is not None else 443
        if not 1 <= port <= 65535 or parsed.netloc.endswith(":"):
            raise refused()
        try:
            ip = ipaddress.ip_address(host)
        except ValueError:
            if (
                not re.fullmatch(r"[a-z0-9-]+(?:\.[a-z0-9-]+)*", host)
                or any(
                    label.startswith("-") or label.endswith("-") or len(label) > 63
                    for label in host.split(".")
                )
                or len(host) > 253
                or re.fullmatch(r"(?:[0-9]+|0x[0-9a-f]+)", host.split(".")[-1])
            ):
                raise refused() from None
            authority = host
        else:
            host = str(ip)
            authority = "[" + host + "]" if ip.version == 6 else host
        authority += ":" + str(port) if port != 443 else ""
        path = canonical_path(parsed.path)
        canonical = urlunsplit(SplitResult("https", authority, path, parsed.query, parsed.fragment))
        if re.search(r"(?:^|[/:#?=&])latest(?:$|[/:#?=&])", canonical, re.I):
            raise refused()
        document = urlunsplit(SplitResult("https", authority, path, parsed.query, ""))
        return ResourceURL(
            canonical,
            document,
            "https://" + authority,
            host,
            port,
            path + ("?" + parsed.query if parsed.query else ""),
            authority,
        )
    except ValueError:
        raise refused() from None
