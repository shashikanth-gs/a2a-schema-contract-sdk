"""Policy decisions are explicit and stable across Python ipaddress releases."""

import ssl

import pytest

from a2a_schema_contract.core import ContractError
from a2a_schema_contract.operations import ValidationOptions
from a2a_schema_contract.resolver import ContractResolver, ResolverLimits
from a2a_schema_contract.resolver.policy import public_address, resource_url
from a2a_schema_contract.uri import canonical_http


@pytest.mark.parametrize(
    "value",
    [
        "http://example.test/x",
        "https://user@example.test/x",
        "https://:pass@example.test/x",
        "https://example.test./x",
        "https://127.1/x",
        "https://0x7f000001/x",
        "https://0177.0.0.1/x",
        "https://2130706433/x",
        "https://127.00.0.1/x",
        "https://%31%32%37.0.0.1/x",
        "https://[fe80::1%25en0]/x",
        "https://example.test:0/x",
        "https://example.test:65536/x",
        "https://example.test:/x",
        "https://example.test/ bad",
        "https://example.test/\\x",
        "https://example.test/%xx",
        "https://example.test/latest/x",
        "https://example.test/?latest",
        "https://éxample.test/x",
        "https:///x",
        "https://-/x",
        "https://example.test/\nsecret",
        "https://example.test/\x00x",
        "https://[oops]/x",
    ],
)
def test_policy_refuses_ambiguous_urls(value: str) -> None:
    with pytest.raises(ContractError, match="RESOLUTION_POLICY"):
        resource_url(value)


@pytest.mark.parametrize(
    "value",
    [
        "0.1.2.3",
        "10.0.0.1",
        "127.0.0.1",
        "100.64.0.1",
        "100.127.1.1",
        "169.254.169.254",
        "172.16.0.1",
        "172.31.1.1",
        "192.0.2.1",
        "192.0.0.1",
        "192.168.1.1",
        "192.88.99.1",
        "198.18.0.1",
        "198.19.1.1",
        "198.51.100.1",
        "203.0.113.1",
        "224.1.1.1",
        "255.255.255.255",
        "168.63.129.16",
        "::",
        "::1",
        "::ffff:8.8.8.8",
        "64:ff9b::808:808",
        "fc00::1",
        "fe80::1",
        "ff02::1",
        "2001::1",
        "2001:100::1",
        "2001:db8::1",
        "2002::1",
        "3fff::1",
        "invalid",
        "2001:4860:4860::8888%fake",
    ],
)
def test_special_use_refused(value: str) -> None:
    assert not public_address(value)


@pytest.mark.parametrize(
    "value",
    [
        "8.8.8.8",
        "1.1.1.1",
        "100.63.1.1",
        "100.128.1.1",
        "172.15.1.1",
        "172.32.1.1",
        "2001:4860:4860::8888",
    ],
)
def test_public_addresses(value: str) -> None:
    assert public_address(value)


def test_canonical_uri_and_fragments() -> None:
    value = resource_url("HTTPS://EXAMPLE.test:443/a/../v1.json#/$defs/a")
    assert value.value == "https://example.test/v1.json#/$defs/a"
    assert value.document == "https://example.test/v1.json"
    assert value.authority == "example.test"
    assert resource_url("https://[2001:4860:4860:0:0:0:0:8888]/").hostname == "2001:4860:4860::8888"


@pytest.mark.parametrize(
    "kwargs", [{"deadline": 3}, {"deadline": 0}, {"concurrent": 5}, {"concurrent": True}]
)
def test_validation_hard_maxima(kwargs: dict[str, int]) -> None:
    with pytest.raises(ValueError):
        ValidationOptions(**kwargs)


@pytest.mark.parametrize(
    "kwargs",
    [
        {"deadline": 11},
        {"deadline": 0},
        {"documents": 33},
        {"schemas": 257},
        {"cache_entries": -1},
        {"redirects": 4},
        {"concurrent": True},
        {"response_bytes": 0},
    ],
)
def test_resolver_hard_maxima(kwargs: dict[str, int]) -> None:
    with pytest.raises(ValueError):
        ResolverLimits(**kwargs)


def test_configuration_cannot_disable_tls_verification() -> None:
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    tls.check_hostname = False
    with pytest.raises(ValueError):
        ContractResolver(tls=tls)
    tls.verify_mode = ssl.CERT_NONE
    with pytest.raises(ValueError):
        ContractResolver(tls=tls)


@pytest.mark.parametrize(
    "path,expected",
    [
        ("/a/.", "/a/"),
        ("/a/..", "/"),
        ("/a/%2e%2E/v1", "/v1"),
        ("/../v1", "/v1"),
        ("/a//v1", "/a//v1"),
        ("/a/%2E/v1", "/a/v1"),
    ],
)
def test_native_and_retrieval_uri_identity_share_canonical_paths(path: str, expected: str) -> None:
    assert (
        resource_url("https://EXAMPLE.test:443" + path).document
        == "https://example.test" + expected
    )
    assert canonical_http("http://EXAMPLE.test:80" + path) == "http://example.test" + expected
    assert canonical_http("urn:example:1") == "urn:example:1"


def test_native_uri_bad_authority_and_ipv6() -> None:
    with pytest.raises(ValueError):
        canonical_http("https:opaque")
    assert (
        canonical_http("https://[2001:4860:0:0:0:0:0:8888]:8443/v1")
        == "https://[2001:4860::8888]:8443/v1"
    )
