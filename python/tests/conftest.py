"""Test-only explicit child coverage, without inheriting application environment.

The production bootstrap remains sterile. When pytest-cov is active, this fixture
instruments the same fixed worker code and pytest-cov combines suffix data files.
Lifecycle tests also exercise the uninstrumented bootstrap and real processes.
"""

from collections.abc import Iterator
from pathlib import Path

import coverage
import pytest

from a2a_schema_contract.operations import process


@pytest.fixture(scope="session", autouse=True)
def child_coverage() -> Iterator[None]:
    active = coverage.Coverage.current()
    if active is None:
        yield
        return
    root = Path(__file__).resolve().parents[1]
    original = process.bootstrap

    def instrumented() -> str:
        bootstrap = original()
        prefix = bootstrap[: bootstrap.index("from a2a_schema_contract.operations.worker")]
        return (
            prefix
            + "import coverage; _measurement = coverage.Coverage("
            + "data_file="
            + repr(str(root / ".coverage"))
            + ", data_suffix=True, config_file="
            + repr(str(root / "pyproject.toml"))
            + "); _measurement.start(); "
            + "from a2a_schema_contract.operations.worker import main; main(); "
            + "_measurement.stop(); _measurement.save()"
        )

    process.bootstrap = instrumented
    try:
        yield
    finally:
        process.bootstrap = original
