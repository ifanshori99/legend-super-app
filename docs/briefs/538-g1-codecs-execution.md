# 538-G1 execution plan

Source: `538-gelombang-backend-umum.md` and `538-g1-config-codecs.md` in the main checkout.

Six independent implementers own one domain codec and one root test file each: tax rules (j568k), service charge (ure5h), zones (qeott), checklists (f7t7z), loyalty policy (1tzvg), facilities (u74y8). They inspect the existing domain and API export contract, check prior commits, then write registration and behavior tests. Root runs the combined failing tests before authorizing implementation.

Root owns shared integration: domain barrel exports, platform registry/decode ordering and context, strict bundle schema alignment, and existing registry test expectations. Keep codecs platform-independent and reject unresolved references. Preserve stored bundle compatibility where supported by existing schemas. No API persistence or migration changes.

Verification: focused root tests through `LEGEND_TEST_FILES` and `heavy pnpm test`; shared package typecheck through `heavy`; eslint and prettier on changed files. One fresh reviewer checks the complete diff while tests run. Root fixes genuine findings and reruns affected checks, documents evidence in PROGRESS, and commits locally per card. No push or merge.

Review focus: source identifiers and transactions omitted; cross-section references resolved or rejected; duplicate keys rejected; monetary values preserved exactly and invalid values refused; current stored bundle exports remain parseable.

## 538-G1b architect fixes

Source: main checkout `docs/briefs/538-g1b-fix-architect.md`. Tax implementer owns P1 effective-date/asOf engine ordering, then separate P2 explicit refusal of unsupported outlet/settings exports. Facilities implementer owns P2 tax ownership; root changes registry ownership map, keeping tenant-wide versus matching outlet references. Loyalty implementer and root enforce P3 explicit point-lock decision (`number | null`); stored-template implementer owns P3 read compatibility without relaxing modern import. Each finding gets failing-first tests and a separate local commit. Root runs one heavy command at a time and combines final focused tests, shared typecheck and changed-file lint/format with one fresh review of fixes. No push/merge.
