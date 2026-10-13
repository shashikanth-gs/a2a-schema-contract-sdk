"""Private ECMA-262-to-Python regex compilation; advertised schemas stay unchanged."""

from urllib.parse import quote, unquote, urldefrag, urljoin

from a2a_schema_contract.core import JsonValue

from .profile import ARRAY_SCHEMAS, MAP_SCHEMAS, ONE_SCHEMA


def portable_pattern(pattern: str) -> str:
    """Input already passed profile preflight; preserve classes and literal escapes."""
    result: list[str] = []
    index = 0
    while index < len(pattern):
        char = pattern[index]
        if char == "\\":
            result.append(pattern[index : index + 2])
            index += 2
            continue
        if char == "[":
            end = pattern.index("]", index + 1)
            result.append(pattern[index : end + 1])
            index = end + 1
            continue
        result.append(r"\Z" if char == "$" else char)
        index += 1
    return "".join(result)


def _absolute(reference: str, base: str) -> str:
    # urllib.urljoin does not resolve fragments against opaque URNs.
    return urldefrag(base)[0] + reference if reference.startswith("#") else urljoin(base, reference)


def _pointer(token: str) -> str:
    return token.replace("~", "~0").replace("/", "~1")


def project_patterns(schema: JsonValue, entry: str) -> JsonValue:
    """Compile regex keys and rewrite native pointer references to renamed schema locations.

    Each nested $id keeps its resource identity. Pointers into embedded resources
    also retain the document-root alias. Only the private validator tree changes.
    """
    locations: dict[str, str] = {}
    references: list[tuple[dict[str, JsonValue], str, str, str]] = []

    def visit(
        node: JsonValue,
        base: str,
        paths: list[tuple[str, str, str]],
    ) -> JsonValue:
        if isinstance(node, dict) and isinstance(node.get("$id"), str):
            identifier = node["$id"]
            assert isinstance(identifier, str)
            base = _absolute(identifier, base)
            paths = [*paths, (urldefrag(base)[0], "", "")]
        for uri, before, after in paths:
            locations[uri + "#" + before] = uri + "#" + quote(after, safe="/~!$&'()*+,;=:@?-._")
        if not isinstance(node, dict):
            return node
        result = dict(node)
        for key, value in node.items():
            if key == "pattern" and isinstance(value, str):
                result[key] = portable_pattern(value)
            if key in ("$ref", "$dynamicRef") and isinstance(value, str):
                references.append((result, key, value, base))
            if key in MAP_SCHEMAS and isinstance(value, dict):
                mapped: dict[str, JsonValue] = {}
                for name, child in value.items():
                    renamed = portable_pattern(name) if key == "patternProperties" else name
                    mapped[renamed] = visit(
                        child,
                        base,
                        [
                            (
                                uri,
                                before + f"/{key}/{_pointer(name)}",
                                after + f"/{key}/{_pointer(renamed)}",
                            )
                            for uri, before, after in paths
                        ],
                    )
                result[key] = mapped
            elif key in ONE_SCHEMA:
                result[key] = visit(
                    value,
                    base,
                    [(uri, before + f"/{key}", after + f"/{key}") for uri, before, after in paths],
                )
            elif key in ARRAY_SCHEMAS and isinstance(value, list):
                result[key] = [
                    visit(
                        child,
                        base,
                        [
                            (uri, before + f"/{key}/{index}", after + f"/{key}/{index}")
                            for uri, before, after in paths
                        ],
                    )
                    for index, child in enumerate(value)
                ]
        return result

    compiled = visit(schema, entry, [(entry, "", "")])
    for node, key, reference, base in references:
        absolute = _absolute(reference, base)
        uri, fragment = urldefrag(absolute)
        if fragment.startswith("/"):
            mapped = locations.get(uri + "#" + unquote(fragment))
            if mapped is not None:
                node[key] = mapped
    return compiled
