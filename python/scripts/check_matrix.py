"""Repeat operational acceptance in fresh locked environments on supported interpreters."""

import json
import os
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    reports: list[dict[str, str]] = []
    (ROOT / "reports").mkdir(exist_ok=True)
    for version in ("3.11", "3.12", "3.13", "3.14"):
        with tempfile.TemporaryDirectory(prefix=f"schema-contract-{version}-") as directory:
            environment = dict(os.environ, UV_PROJECT_ENVIRONMENT=str(Path(directory) / "venv"))
            output: list[str] = []
            for command in (
                ["uv", "sync", "--locked", "--all-extras", "--python", version],
                ["uv", "run", "--locked", "python", "--version"],
                ["uv", "run", "--locked", "ruff", "check", "src", "tests", "scripts", "examples"],
                [
                    "uv",
                    "run",
                    "--locked",
                    "ruff",
                    "format",
                    "--check",
                    "src",
                    "tests",
                    "scripts",
                    "examples",
                ],
                ["uv", "run", "--locked", "mypy"],
                [
                    "uv",
                    "run",
                    "--locked",
                    "pytest",
                    "-q",
                    "--cov",
                    "--cov-report=term-missing",
                    "--cov-report=json:reports/coverage.json",
                ],
                [
                    "uv",
                    "run",
                    "--locked",
                    "coverage",
                    "json",
                    "--include=*/core/*",
                    "--fail-under=100",
                    "-o",
                    "reports/core-coverage.json",
                ],
                ["uv", "run", "--locked", "python", "scripts/check_package.py"],
            ):
                result = subprocess.run(
                    command,
                    cwd=ROOT,
                    env=environment,
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    timeout=180,
                )
                output.append(result.stdout)
                (ROOT / "reports" / f"python-{version}.log").write_text("\n".join(output))
                if result.returncode:
                    print(result.stdout)
                    raise SystemExit(result.returncode)
            for name in ("package-check", "core-coverage", "coverage"):
                (ROOT / "reports" / f"{name}-{version}.json").write_bytes(
                    (ROOT / "reports" / f"{name}.json").read_bytes()
                )
            reports.append({"python": version, "result": "PASS"})
            print(
                f"Python {version}: quality, tests and isolated artifact consumers PASS", flush=True
            )
    (ROOT / "reports/matrix.json").write_text(json.dumps(reports, indent=2) + "\n")


if __name__ == "__main__":
    main()
