# Node release candidate and publication policy

The candidate package is **`a2a-schema-contract@0.1.0-rc.0`**, unscoped at the
maintainer's request. It can be installed from the reviewed npm tarball. It is
not available from the npm registry yet. `private: true` keeps publishing disabled.
The public registry returned E404 for the chosen name on 2026-10-06; that result
does not reserve the name or establish ownership. No existing scope ownership
applies to this unscoped, unpublished package.

## Reproduce a candidate

Use the exact source revision and artifact hash recorded by the independent
reference's `js/artifact-input.json`. From SDK `js/`:

```sh
npm ci
npm run check
npm run check:clean
npm run release:rehearsal
```

The rehearsal performs a pack dry run, packs the same build twice and checks
identical SHA-256 hashes and file lists. It retains version, checksum, integrity,
runtime and proposed immutable tag in `reports/release-node*.json`. It creates no
tag, GitHub release or registry publication. The manual
`release-candidate.yml` workflow performs the same candidate gate with read-only
repository permissions and uploads reviewable artifacts.

The ordinary Node workflow validates Linux on both supported runtimes and
macOS/Windows on Node 24, including installed consumers, structural fixtures,
hostile-worker cleanup, benchmarks and dependency audits. The reference workflow
builds the exact SDK revision, verifies the locked tarball hash and runs the
reference in a fresh copy that excludes the SDK checkout. Hosted evidence must
pass for the actual candidate revision; an older green run is insufficient.

## Versions and compatibility

| Identifier | Policy |
|---|---|
| npm package | SemVer; this release is `0.1.0-rc.0`, independently versioned from Python. |
| A2A protocol | Exactly 1.0 over JSON-RPC/HTTP/SSE with official peer 1.3.0. |
| Extension URI | `https://w3id.org/a2a-schema-contract/draft/0.1`; it identifies the pinned draft, not the npm version. |
| Domain contract ID | Immutable, absolute and explicitly versioned by its advertiser. |
| Schema dialect | Documented JSON Schema 2020-12 profile; changing the package version does not widen it silently. |
| Release tags | Immutable `js-v<package-version>`; Python will use its own prefix after parity. Never move a published tag. |

The previous private development artifact used a maintainer-scoped name. This
candidate changes imports to `a2a-schema-contract` and its public subpaths. Update
the artifact pin, dependency lock and imports together; rerun consumer checks.
No published npm consumers need migration. New `close()` methods permit explicit
shutdown. Existing trusted synchronous helpers remain, while async transport
boundaries automatically isolate schema work.

Runtime dependencies and the official optional peer are exact pins, so the
declared minimum and maximum dependency versions are the same artifacts. Core,
resolver and isolated validation imports work without Express, TypeScript or the
official peer. Client/server imports require the exact peer. No browser, CommonJS,
other-transport, full-dialect or Python compatibility is implied.

## Separately authorized first publication

Before a future first publication, create/authenticate the maintainer npm account,
recheck name availability and npm's name-conflict rules, and establish package
ownership. Review the accepted candidate hash and completed CI evidence. Change
`private` only in an explicitly authorized publication change. Perform that first
publication with the selected dist-tag and an immutable language-prefixed tag.

After the package exists, configure its npm trusted publisher for this repository,
the actual publication workflow and a protected release environment. That
workflow may use short-lived OIDC identity and provenance with narrowly scoped
permissions. OIDC binding and registry provenance cannot be verified before an
initial package/account exists, and are not claimed by the local rehearsal. No
publish-enabled workflow or publishing credential is added by M3.

Report security issues through [SECURITY.md](../SECURITY.md). Contributions and
check commands are in [CONTRIBUTING.md](../CONTRIBUTING.md). Python parity, joint
release maintenance policy, bundles and XML remain their separately tracked work.
