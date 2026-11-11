# 538-G1 execution plan

Source: `538-gelombang-backend-umum.md` and `538-g1-config-codecs.md` in the main checkout.

Six independent implementers own one domain codec and one root test file each: tax rules (j568k), service charge (ure5h), zones (qeott), checklists (f7t7z), loyalty policy (1tzvg), facilities (u74y8). They inspect the existing domain and API export contract, check prior commits, then write registration and behavior tests. Root runs the combined failing tests before authorizing implementation.

Root owns shared integration: domain barrel exports, platform registry/decode ordering and context, strict bundle schema alignment, and existing registry test expectations. Keep codecs platform-independent and reject unresolved references. Preserve stored bundle compatibility where supported by existing schemas. No API persistence or migration changes.

Verification: focused root tests through `LEGEND_TEST_FILES` and `heavy pnpm test`; shared package typecheck through `heavy`; eslint and prettier on changed files. One fresh reviewer checks the complete diff while tests run. Root fixes genuine findings and reruns affected checks, documents evidence in PROGRESS, and commits locally per card. No push or merge.

Review focus: source identifiers and transactions omitted; cross-section references resolved or rejected; duplicate keys rejected; monetary values preserved exactly and invalid values refused; current stored bundle exports remain parseable.
