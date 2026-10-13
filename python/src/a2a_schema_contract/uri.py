"""Shared HTTP URI identity normalization; acquisition policy is separate."""

import ipaddress
from urllib.parse import urlsplit, urlunsplit


def canonical_path(path: str) -> str:
    segments: list[str] = []
    values = (path or "/").split("/")
    for index, segment in enumerate(values):
        dot = segment.lower().replace("%2e", ".")
        if dot == "..":
            if len(segments) > 1:
                segments.pop()
        elif dot != ".":
            segments.append(segment)
        if dot in (".", "..") and index == len(values) - 1:
            segments.append("")
    result = "/".join(segments) or "/"
    return result if result.startswith("/") else "/" + result


def canonical_http(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme not in ("http", "https"):
        return value
    host = parsed.hostname
    if host is None or parsed.username is not None or parsed.password is not None:
        raise ValueError("Invalid HTTP resource identity.")
    authority = "[" + str(ipaddress.IPv6Address(host)) + "]" if ":" in host else host.lower()
    port = parsed.port
    if port is not None and port != (443 if parsed.scheme == "https" else 80):
        authority += ":" + str(port)
    return urlunsplit(
        (parsed.scheme, authority, canonical_path(parsed.path), parsed.query, parsed.fragment)
    )
