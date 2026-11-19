"""Build and compare Python distributions from an immutable Git revision; never publish."""

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from email.parser import BytesParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def run(args: list[str], *, cwd: Path, env: dict[str, str]) -> str:
    return subprocess.run(
        args, cwd=cwd, env=env, check=True, capture_output=True, text=True, timeout=120
    ).stdout.strip()


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision", required=True, help="Git commit to build")
    args = parser.parse_args()
    env = dict(os.environ, SOURCE_DATE_EPOCH="1767225600")
    revision = run(["git", "rev-parse", "--verify", args.revision + "^{commit}"], cwd=ROOT, env=env)
    with tempfile.TemporaryDirectory(prefix="schema-contract-rehearsal-") as directory:
        temp = Path(directory)
        archive = temp / "source.tar"
        with archive.open("wb") as output:
            subprocess.run(
                ["git", "archive", "--format=tar", revision, "python"],
                cwd=ROOT,
                env=env,
                stdout=output,
                check=True,
                timeout=120,
            )
        source = temp / "source"
        source.mkdir()
        with tarfile.open(archive) as tar:
            # The archive is from Git, but refuse links and path escapes before extraction.
            for member in tar.getmembers():
                if member.issym() or member.islnk() or not (member.isfile() or member.isdir()):
                    raise ValueError(f"Unsupported archived entry: {member.name}")
                if Path(member.name).is_absolute() or ".." in Path(member.name).parts:
                    raise ValueError(f"Unsafe archived entry: {member.name}")
            if hasattr(tarfile, "data_filter"):
                tar.extractall(source, filter="data")
            else:  # Python 3.11 before the extraction-filter backport.
                tar.extractall(source)
        project = source / "python"
        first, second, rebuilt = (temp / name for name in ("first", "second", "rebuilt"))
        for target in (first, second):
            run(["uv", "build", "--out-dir", str(target)], cwd=project, env=env)

        def distributions(directory: Path) -> list[str]:
            return sorted(
                p.name for p in directory.iterdir() if p.name.endswith((".whl", ".tar.gz"))
            )

        first_files = distributions(first)
        if first_files != distributions(second) or len(first_files) != 2:
            raise RuntimeError("Build distribution file lists differ")
        for name in first_files:
            if digest(first / name) != digest(second / name):
                raise RuntimeError(f"Builds differ: {name}")
        wheel = next(first.glob("*.whl"))
        sdist = next(first.glob("*.tar.gz"))
        run(["uv", "build", str(sdist), "--wheel", "--out-dir", str(rebuilt)], cwd=temp, env=env)
        if digest(wheel) != digest(next(rebuilt.glob("*.whl"))):
            raise RuntimeError("Wheel rebuilt from sdist differs")
        run(
            [sys.executable, "-m", "twine", "check", "--strict", str(wheel), str(sdist)],
            cwd=temp,
            env=env,
        )
        with zipfile.ZipFile(wheel) as package:
            names = package.namelist()
            metadata = BytesParser().parsebytes(
                package.read(next(name for name in names if name.endswith("/METADATA")))
            )
            if (
                metadata["Name"] != "a2a-schema-contract"
                or metadata["License-Expression"] != "Apache-2.0"
            ):
                raise RuntimeError("Unexpected distribution metadata")
            if metadata["Requires-Python"] != "<3.15,>=3.11" or set(
                metadata.get_all("Provides-Extra", [])
            ) != {"a2a", "server"}:
                raise RuntimeError("Unexpected supported runtime or extras")
            if "a2a_schema_contract/py.typed" not in names:
                raise RuntimeError("Missing type marker")
            if len([name for name in names if name.endswith(".schema.json")]) != 7:
                raise RuntimeError("Missing pinned schemas")
            if not any(name.endswith("/licenses/LICENSE") for name in names):
                raise RuntimeError("Missing packaged license")
        version = metadata["Version"]
        report = {
            "result": "PASS",
            "sourceCommit": revision,
            "sourceDateEpoch": env["SOURCE_DATE_EPOCH"],
            "python": sys.version.split()[0],
            "uv": run(["uv", "--version"], cwd=temp, env=env),
            "platform": sys.platform,
            "proposedTag": "python-v" + version,
            "wheel": {"name": wheel.name, "sha256": digest(wheel)},
            "sdist": {"name": sdist.name, "sha256": digest(sdist)},
            "checks": ["two-builds", "sdist-wheel-rebuild", "twine-strict", "metadata-resources"],
            "publication": "Not performed; ownership and release authorization remain open.",
            "provenance": "Local source and checksums only; no registry attestation.",
        }
    destination = ROOT / "python/reports/release-rehearsal.json"
    destination.parent.mkdir(exist_ok=True)
    destination.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
