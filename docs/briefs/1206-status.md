# 1206 Status merge train batch100 (20 Nov)

- Cabang: `int/batch100` dari `int/batch99` (ea2aec38b). Belum mendarat; full run menyusul.
- Digabung: `ws/1203-tukar-poin-backend` (059d155fa, memuat ws/1165 748364714). Merge commit c3291833b.
- Peta renumber: `0733_member_qr_redeem_mints` (when 1795000000110) -> `0512_member_qr_redeem_mints` (when 1795000022101). Referensi "migration 0733" di crm-ledger.ts dan crm-member.custom.sql diganti 0512. Tidak ada referensi registry test lain.
- Konflik: `_journal.json` (dibangun ulang skrip), `mock/control.ts` (simpan kedua sisi), `docs/PROGRESS.md` (kedua entri), `i18n/messages/id.ts` (blok tukarPoin + nav dari 1203; sisi HEAD kosong). Semua mekanis, bukan hunk non-trivial.
- Perbaikan tambahan: `tests/crm-contract.test.mjs` jumlah endpoint CRM 49 -> 52 (3 endpoint tukar poin).
- Gate: prettier hijau (37 berkas); lint 0 error (2 warning lama ws07); typecheck 3/3; contract 873/873; db:generate "No schema changes"; vitest 6 berkas/181 test hijau (member-points-redeem-1203, member-qr-mint, pos-1059-points, pos-936-points, pos-void-refund-ceilings, data-import-registry).
- Belum: full `pnpm test` dan `pnpm check`.
