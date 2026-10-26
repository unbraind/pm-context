# Published pm SDK capability floor

Audited main: `41fa36e1eae25b7ce692de6b9d198c0b05730acd`. Required API floor: **2026.10.9**.

Declared host floor: `2026.10.23`. npm peer: `>=2026.10.23`.

floor verified: the host declaration and the npm peer or exact runtime dependency already cover every API below. No floor change is needed.

## Artifact method and limits

The published version list was obtained with `npm view @unbrained/pm-cli versions --json`. Each capability was bisected over stable published releases, with its first providing release and adjacent previous stable release inspected. Prereleases do not satisfy these stable npm minimum ranges. Tarballs were downloaded with `npm pack @unbrained/pm-cli@VERSION --ignore-scripts` into an isolated scratch directory and inspected as data. No downloaded pm package code or lifecycle script was executed.

Public module exports were checked against both `package.json` entrypoints and the static ESM runtime export graph, then their `dist` declarations. Client methods and context members were read from the published declarations, including inherited members and static methods. A context property is attributed to the context used by this package, rather than a later base-interface refactor. TypeScript symbol resolution covers aliases, typed lazy loaders, destructuring, and clients passed through helpers. Erased interfaces do not create runtime requirements; imported function/constructor types used by loaders are retained conservatively.

This establishes API availability. It does not attest older-host runtime semantics, provider integration, or execution on the declared minimum. The current pinned SDK remains the local test host.

## API to first-version table

The machine-readable source inventory and artifact hashes are in [sdk-floor.json](sdk-floor.json). Source locations refer to the audited main commit.

| Used API | First stable release | Previous stable release lacking it | Source uses |
| --- | --- | --- | --- |
| `@unbrained/pm-cli/sdk :: acquireLock` | 2026.5.14 | 2026.5.12 | [context-receipts.ts:5](../context-receipts.ts#L5), [since.ts:6](../since.ts#L6) |
| `@unbrained/pm-cli/sdk :: applyHistoryPatch` | 2026.7.15 | 2026.7.14 | [since.ts:6](../since.ts#L6) |
| `@unbrained/pm-cli/sdk :: createRelationshipKindRegistry` | 2026.7.15 | 2026.7.14 | [index.ts:27](../index.ts#L27) |
| `@unbrained/pm-cli/sdk :: encodePmTableRows` | 2026.10.9 | 2026.10.8 | [next-evidence.ts:4](../next-evidence.ts#L4) |
| `@unbrained/pm-cli/sdk :: getActiveExtensionRegistrations` | 2026.5.14 | 2026.5.12 | [file-focus.ts:4](../file-focus.ts#L4) |
| `@unbrained/pm-cli/sdk :: listMutationEvents` | 2026.7.25 | 2026.7.24 | [since.ts:6](../since.ts#L6) |
| `@unbrained/pm-cli/sdk :: locateItem` | 2026.5.14 | 2026.5.12 | [freshness.ts:6](../freshness.ts#L6) |
| `@unbrained/pm-cli/sdk :: PmCliError` | 2026.5.14 | 2026.5.12 | [freshness.ts:6](../freshness.ts#L6), [evidence-packing.ts:2](../evidence-packing.ts#L2), [next-evidence.ts:5](../next-evidence.ts#L5), [witnesses.ts:2](../witnesses.ts#L2), [since.ts:6](../since.ts#L6) |
| `@unbrained/pm-cli/sdk :: readHistoryEntries` | 2026.7.15 | 2026.7.14 | [since.ts:6](../since.ts#L6) |
| `@unbrained/pm-cli/sdk :: readLocatedItem` | 2026.5.14 | 2026.5.12 | [freshness.ts:6](../freshness.ts#L6), [file-focus.ts:4](../file-focus.ts#L4) |
| `@unbrained/pm-cli/sdk :: readSettings` | 2026.5.14 | 2026.5.12 | [index.ts:27](../index.ts#L27), [file-focus.ts:4](../file-focus.ts#L4) |
| `@unbrained/pm-cli/sdk :: readSettingsWithMetadata` | 2026.7.23 | 2026.7.22 | [freshness.ts:6](../freshness.ts#L6) |
| `@unbrained/pm-cli/sdk :: RelationshipKindRegistry` | 2026.7.15 | 2026.7.14 | [since.ts:7](../since.ts#L7), [index.ts:20](../index.ts#L20) |
| `@unbrained/pm-cli/sdk :: resolveItemTypeRegistry` | 2026.5.14 | 2026.5.12 | [freshness.ts:6](../freshness.ts#L6), [file-focus.ts:4](../file-focus.ts#L4) |
| `@unbrained/pm-cli/sdk :: resolveRuntimeStatusRegistry` | 2026.5.14 | 2026.5.12 | [index.ts:27](../index.ts#L27) |
| `@unbrained/pm-cli/sdk :: resolveWorkspaceRelationshipKindRegistry` | 2026.7.21 | 2026.7.20 | [since.ts:6](../since.ts#L6), [index.ts:27](../index.ts#L27) |
| `@unbrained/pm-cli/sdk/core :: listAllComplete` | 2026.8.18 | 2026.8.17 | [index.ts:33](../index.ts#L33) |
| `@unbrained/pm-cli/sdk/query :: buildItemContextRelevanceCandidates` | 2026.7.26 | 2026.7.25 | [index.ts:35](../index.ts#L35) |
| `@unbrained/pm-cli/sdk/query :: certifyCompleteListResult` | 2026.8.18 | 2026.8.17 | [index.ts:35](../index.ts#L35) |
| `@unbrained/pm-cli/sdk/query :: defaultScoreContextCandidates` | 2026.7.26 | 2026.7.25 | [index.ts:35](../index.ts#L35) |
| `@unbrained/pm-cli/sdk/query :: packContextCandidates` | 2026.7.26 | 2026.7.25 | [evidence-packing.ts:3](../evidence-packing.ts#L3), [index.ts:35](../index.ts#L35) |
| `@unbrained/pm-cli/sdk/query :: PmCompleteListValidationError` | 2026.8.18 | 2026.8.17 | [index.ts:35](../index.ts#L35) |
| `@unbrained/pm-cli/sdk/query :: readContextUsageAffinity` | 2026.7.26 | 2026.7.25 | [index.ts:50](../index.ts#L50) |
| `@unbrained/pm-cli/sdk/query :: recordContextUsageServing` | 2026.7.26 | 2026.7.25 | [index.ts:35](../index.ts#L35) |
| `@unbrained/pm-cli/sdk/query :: runActivity` | 2026.8.2 | 2026.8.1 | [since.ts:8](../since.ts#L8) |
| `CommandHandlerContext.args` | 2026.5.1 | 2026.3.12 | [index.ts:1394](../index.ts#L1394), [index.ts:1512](../index.ts#L1512), [index.ts:1531](../index.ts#L1531), [index.ts:1550](../index.ts#L1550) |
| `CommandHandlerContext.global` | 2026.5.1 | 2026.3.12 | [index.ts:1265](../index.ts#L1265), [index.ts:1290](../index.ts#L1290), [index.ts:1321](../index.ts#L1321), [index.ts:1511](../index.ts#L1511), [index.ts:1530](../index.ts#L1530), [index.ts:1549](../index.ts#L1549), [index.ts:1571](../index.ts#L1571), [index.ts:1602](../index.ts#L1602), [index.ts:1800](../index.ts#L1800) |
| `CommandHandlerContext.options` | 2026.5.1 | 2026.3.12 | [index.ts:1265](../index.ts#L1265), [index.ts:1290](../index.ts#L1290), [index.ts:1320](../index.ts#L1320), [index.ts:1321](../index.ts#L1321), [index.ts:1387](../index.ts#L1387), [index.ts:1510](../index.ts#L1510), [index.ts:1511](../index.ts#L1511), [index.ts:1514](../index.ts#L1514), [index.ts:1529](../index.ts#L1529), [index.ts:1530](../index.ts#L1530), [index.ts:1533](../index.ts#L1533), [index.ts:1548](../index.ts#L1548), [index.ts:1549](../index.ts#L1549), [index.ts:1551](../index.ts#L1551), [index.ts:1569](../index.ts#L1569), [index.ts:1570](../index.ts#L1570), [index.ts:1571](../index.ts#L1571), [index.ts:1575](../index.ts#L1575), [index.ts:1578](../index.ts#L1578), [index.ts:1600](../index.ts#L1600), [index.ts:1601](../index.ts#L1601), [index.ts:1603](../index.ts#L1603), [index.ts:1642](../index.ts#L1642), [index.ts:1741](../index.ts#L1741) |
| `CommandHandlerContext.pm_root` | 2026.5.1 | 2026.3.12 | [index.ts:1263](../index.ts#L1263), [index.ts:1269](../index.ts#L1269), [index.ts:1299](../index.ts#L1299), [index.ts:1316](../index.ts#L1316), [index.ts:1394](../index.ts#L1394), [index.ts:1406](../index.ts#L1406), [index.ts:1532](../index.ts#L1532), [index.ts:1578](../index.ts#L1578), [index.ts:1597](../index.ts#L1597), [index.ts:1599](../index.ts#L1599), [index.ts:1658](../index.ts#L1658), [index.ts:1769](../index.ts#L1769), [index.ts:1774](../index.ts#L1774), [index.ts:1776](../index.ts#L1776), [index.ts:1791](../index.ts#L1791) |
| `CommandHandlerContext.repo_root` | 2026.7.25 | 2026.7.24 | [index.ts:1394](../index.ts#L1394), [index.ts:1578](../index.ts#L1578) |
| `CommandHandlerContext.source_workspace_root` | 2026.7.25 | 2026.7.24 | [index.ts:1394](../index.ts#L1394), [index.ts:1578](../index.ts#L1578) |
| `ExtensionApi.registerCommand` | 2026.5.1 | 2026.3.12 | [index.ts:1345](../index.ts#L1345), [index.ts:1501](../index.ts#L1501), [index.ts:1520](../index.ts#L1520), [index.ts:1539](../index.ts#L1539), [index.ts:1558](../index.ts#L1558), [index.ts:1588](../index.ts#L1588), [index.ts:1608](../index.ts#L1608), [index.ts:1718](../index.ts#L1718) |
| `ExtensionApi.registerRenderer` | 2026.5.1 | 2026.3.12 | [index.ts:1815](../index.ts#L1815), [index.ts:1820](../index.ts#L1820), [index.ts:1821](../index.ts#L1821) |
| `RelationshipKindRegistry.resolve` | 2026.7.15 | 2026.7.14 | [since.ts:193](../since.ts#L193), [index.ts:619](../index.ts#L619), [index.ts:785](../index.ts#L785) |

## Tarball provenance

SHA-256 of the exact packed `.tgz` bytes; package archives and extracted files are not committed.

| pm release | Tarball SHA-256 |
| --- | --- |
| 2026.3.12 | `4e4e6a33cb45d665f072120e9e1ce25d2e5773e738cbc914b29e8f54367747fb` |
| 2026.5.1 | `730de8b79aa0074dc2ca81a54ce37f9aaa0a4167b690c9a62b87d2121a8b37f7` |
| 2026.5.12 | `42dcaef84dc441b7792aeffa059bfe10a86ae8b12b1084472229bba03fb29910` |
| 2026.5.14 | `7f7e9131afadb891344bf2fb93b15bc157d18c532a5da4ec31677957d37b7260` |
| 2026.7.14 | `4a42de258a3b1cabff1112dd90ae4f3cc272e25ada229d818becae0f2845e128` |
| 2026.7.15 | `1c5d8e7427d74af157577ff58e0692a986016ee355eaf3a6b5ccebca5a9779aa` |
| 2026.7.20 | `6fbc1d789477491e007d03396dbf1dd2f09376220059887faf6f9d50668a6b08` |
| 2026.7.21 | `99151effed0e40579f01629f135a73384cb8e8f922c6c63da497638507009452` |
| 2026.7.22 | `d013832d6afc97c9a5c6f4a48a497f54a216643f8c7017b9c4f807ce6607532b` |
| 2026.7.23 | `caf1a21b0b587dc55c3509654466dd1e20383e30f2d17b47678887a15a5490af` |
| 2026.7.24 | `ae7757c7e4b02bf5c0908a7bcfd487926912bc2f71332c68c9e1be4017d796ab` |
| 2026.7.25 | `20dfec2ca4ddfcebd484af686b76aebcb1f479a7b81c781380a7fe6b6f8506f5` |
| 2026.7.26 | `b10b647a7fce423106dfb964934ac2d43b8770f8f085df89a13c9a04e75569cc` |
| 2026.8.1 | `242013e81ed2c4329a3cb20d3e70fa58f6dbb627d00c2c1e883562e786850f80` |
| 2026.8.2 | `c9f8e516319ba4d6609ea0272e4fa70360668531c379ec54b29df8aa418293e3` |
| 2026.8.17 | `fda330eb4887031751889ef85b510d52886fa5f70b4813f3951d7eed705023f2` |
| 2026.8.18 | `b00374f0e32c98ccec03a5893d8bfbbae45650f44bd04292ceafd8d9aac059f7` |
| 2026.10.8 | `7ff00d35570db99ebe54143d73c39ef30530f280e136fa4815543ae5da76cdb5` |
| 2026.10.9 | `8cee1bc39b4f3ec24d2738f1c28c517437e4611ed42e908261b74a4fb4bdbf4f` |
