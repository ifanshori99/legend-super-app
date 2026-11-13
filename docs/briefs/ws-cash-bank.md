# Sub-brief: ws/cash-bank (legend-4961 + legend-gq0w)

Cabang kerja dari 52346c44 (ws/settlement-recon). Tingkat K (uang + migrasi + akses).
Migrasi HANYA nomor 0484-0485. Setelah migrasi, `pnpm db:generate` harus kosong.
Jangan sentuh payroll, QRIS, settlement import (payment-settlement-*, gateway recon).
Test terarah: `LEGEND_TEST_FILES="src/test/x.test.ts" heavy pnpm test` dari root worktree. Satu token heavy per thread: hanya subagent yang ditunjuk engineer yang menjalankan tsc/vitest.

## Kartu 1 — legend-4961 Kas & Bank endpoint nyata
PRD v1.7 §3.19 (docs/PRD.md ~l.762). Kas masuk, kas keluar, kas kecil (petty cash) per outlet, transfer antar-rekening.
- Kontrak: `packages/shared/src/accounting/banking.ts` (sudah ada, 21K; perluas, jangan rusak yang ada).
- Aturan posting jurnal: debit = kredit; akun dari peta akun (posting-rules.ts / coa); peta hilang -> parkir dengan kode `ACCOUNT_MAPPING_MISSING`, jangan tebak akun.
- API: route accounting (tenant/outlet guards, requireTrustedOrigin, jsonBody), service, tests `apps/api/src/test/`.
- Web: `apps/web/src/features/ws07-cash-bank` dari mock.ts ke API (api.ts -> queries.ts -> hooks.ts).
- Sudah ada: POS cash-movements `apps/api/src/routes/pos-shift.routes.ts:232`; migrasi 0191 kas-bank-recon (rekening bank, impor CSV, setoran kas); jurnal manual; petty cash mungkin disinggung di supplier-return (PROGRESS l.2085).

Aturan uang founder (test gagal-dulu WAJIB):
1. Transfer antar-rekening seimbang (debit = kredit) dan idempoten: kirim ulang dengan kunci idempoten sama tidak dobel.
2. Kas kecil tidak bisa minus melebihi saldo.
3. Pengguna tanpa izin / outlet lain ditolak (403/404).
4. Tidak ada uang tercatat dua kali (satu dokumen -> satu jurnal).

## Kartu 2 — legend-gq0w re-issue QR/PIN tiket akses
`packages/shared/src/facility`. Kredensial tiket hanya dikembalikan sekali saat issue; tamu perlu menampilkan ulang (reload/perangkat lain). Endpoint re-issue yang diaudit dan dibatasi laju, hanya pemilik tiket. Dep: legend-x1yh (wiring FE facility ke API) — cek apakah API facility & auth tamu sudah nyata; bila tiket/auth belum nyata di API, kartu 2 terblokir.

## Hasil desain
Architect menulis desain ke `docs/briefs/ws-cash-bank-design.md`.

## Pembagian kerja (engineer, 13 Nov)
- Kartu 2 TERBLOKIR (legend-bzih), jangan dikerjakan.
- Desain final: `docs/briefs/ws-cash-bank-design.md` (ikuti persis; ragu = berhenti dan lapor).
- C (implementer): bagian "C" desain, KECUALI file test murni `cash-bank-entries.test.ts` (milik test-writer). Pemegang token heavy tahap 1: hanya C menjalankan `pnpm db:generate`/`db:migrate`. Tanpa tsc.
- T (test-writer): test gagal-dulu 4 aturan uang founder (bagian "Test gagal-dulu") di `apps/api/src/test/accounting-cash-bank-entries.test.ts`, `accounting-petty-cash.test.ts`, dan `packages/shared/src/accounting/cash-bank-entries.test.ts`. Jalankan bukti gagal-dulu hanya setelah C selesai (engineer memberi tahu).
- B (implementer web): bagian "B" desain. Test root ada di `tests/ws07-cash-bank.test.mjs` (cek path). Pakai nama kontrak dari desain; tanpa tsc/vitest. Ikuti `~/.agents/team/ui-standard.md`.
- A (implementer API): bagian "A" desain, mulai setelah C.
- Semua: jangan commit; engineer yang commit.
