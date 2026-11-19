# Python release preparation

`a2a-schema-contract` version `0.1.0.dev0` is a development distribution, not
an accepted release candidate. Its supported Python runtime is CPython 3.11–3.14;
the optional official A2A peer is pinned to 1.2.2. The contract draft identity is
independent of package versions. The npm and Python packages are versioned and
released independently. A Python release tag will use `python-v<version>` and
must never be moved after publication.

## Rehearsal

From a checkout containing the exact commit under review:

```sh
cd python
uv sync --locked --all-extras
uv run python scripts/release_rehearsal.py --revision <full-commit-sha>
```

The rehearsal builds from a Git archive of that commit in a temporary directory,
uses `SOURCE_DATE_EPOCH=1767225600`, builds wheel and sdist twice, compares each
pair's hashes, rebuilds the wheel from the sdist, checks metadata and resources,
and runs `twine check --strict`. It writes the source revision, local artifact
hashes and proposed tag to `python/reports/release-rehearsal.json`. It creates no
tag, release, registry upload or provenance attestation. The read-only
`python-rehearsal.yml` workflow runs it on Python branch pushes or manual dispatch.
Run the separate quality/installed-consumer matrix for the same source revision;
the rehearsal is not a substitute for it.

The universal wheel's uncompressed files matched between the Windows and Linux
hosted builds at `208a3ca3d6f9b05b83e89fc9e05418b138892d07`, but the wheel bytes
did not: ZIP host metadata and compressed byte streams differed. With the fixed
epoch used in SDK CI, Linux's wheel SHA-256 was
`3f811920e2e805d0789d6895a693a6af15bc7e6ac8c1472fb538975f9bf367dc`,
and Windows' was
`8fc1659e1a0ac991329cc224f330b5e844983fa13f018dd36ec0e707a7c565e5`.
The reference matrix must build one wheel from its pinned SDK commit and verify
that exact hash before installing the same bytes on each platform. Hashes from
builds using a different `SOURCE_DATE_EPOCH` are not interchangeable.

## Publication gates

On 2026-11-19, the public PyPI JSON endpoint returned 404 for
`a2a-schema-contract`. This observation is not a reservation, ownership check,
or guarantee the name remains available. Before publishing, the maintainer must
authenticate to the intended PyPI account, verify name eligibility and ownership,
choose the final version, and review the exact source, artifacts and CI evidence.
The independently maintained reference must complete REF-005/006 and REF-008;
parity, supported exclusions and the exact reference revision must be recorded.

Configure PyPI trusted publishing against the actual repository, workflow and
protected environment only when registry ownership and the publication workflow
exist. Verify OIDC identity binding and provenance from the real upload; the
read-only rehearsal does not establish either. Registry credentials, publication,
tag creation and GitHub releases remain separate operations. If an upload fails,
inspect the registry first: never overwrite a published version or move a tag;
prepare a new version when the registry has accepted any release files. Keep the
accepted artifacts and checksums for recovery and audit.

The current hosted SDK matrix passed at `208a3ca` on Linux Python 3.11–3.14 and
macOS/Windows Python 3.14, including dependency audits and installed consumers:
[Python matrix](https://github.com/shashikanth-gs/a2a-schema-contract-sdk/actions/runs/44518594807).
This is implementation evidence, not four-pairing or release acceptance. See the
[security limits](python-resolver-security.md), [Python guide](../python/README.md),
and [Node release policy](node-release.md) for lifecycle and supported profiles.
