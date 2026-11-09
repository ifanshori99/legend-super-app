# Brief: engineer (Opus) — WS-07 kas dan bank: akun, impor mutasi, pencocokan, setoran kas

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/cash-bank-recon` dari `milestone/m1` (94995dad; sudah memuat 2dfe842e dengan kebijakan keuangan cd6fe532 dan parser CSV ketat). Worktree `.worktrees/cash-bank-recon`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

Nomor migrasi dipesan: `0182`, `when` 1794261000000, satu migrasi untuk semua tabel.

## Tujuan
`legend-fnxl` (P2, tingkat K uang). Keputusan CTO: kas-bank murni dulu. Auto-match transaksi gateway menunggu `legend-cs7` (mesin settlement); buat kartu sendiri untuk bagian itu.

Hasil Explore G3xjx: 14 endpoint di `packages/shared/src/accounting/endpoints.ts` (sekitar :408-541) belum punya handler; tabel bank, mutasi, dan setoran kas belum ada; `payment_reconciliation_cases` tidak cocok dipakai ulang. Potongan:
1. Skema + migrasi 0182 + RLS (`bank_accounts`, `bank_statement_imports`, `bank_statement_lines` dengan `dedupe_key` unik, `cash_deposits`, `cash_collections` kecuali diturunkan dari shift POS, `bank_reconciliation_cases` dengan PIC dan log aksi). Pola `tenantIdColumn`, unik (tenant, id), FK komposit, RLS lewat `.custom.sql`. Kerjakan sendiri dulu, dengan keputusan desain lewat satu subagent `architect` dicatat di `docs/DECISIONS.md`.
2. Akun bank (S).
3. Impor CSV mutasi, dedupe, auto-match >= 99% memakai `matchingPolicy.dateToleranceDays` (`loadMatchingPolicy`) dan `parseBankCsvAmount` (L, uang: kamu pegang langsung).
4. Match, exclude, unmatch, ringkasan rekonsiliasi (M).
5. Setoran kas dan alert ACC-05 memakai `loadCashDepositPolicy` (M).
6. Kasus rekonsiliasi dengan PIC (M).
7. Web `features/ws07-cash-bank`: baca `GET finance-policy` alih-alih konstanta 2 hari (`lib.ts` sekitar :630), dan pesan jelas untuk CSV yang ditolak. Tanpa desain baru.

Sesudah potongan 1: potongan 2, 4, 5, 6 lewat `implementer` paralel (berkas service dan route terpisah per potongan), 3 olehmu, 7 terakhir. Buat kartu bd per potongan di bawah legend-fnxl.

## Kartu
Awal: `ghostex board associate legend-fnxl`, `bd update legend-fnxl --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa.

## Scope
Boleh: schema/service/route accounting kas-bank, migrasi 0182, `packages/shared/src/accounting/*` bagian kas-bank, web `ws07-cash-bank`, test. Jangan: posting jurnal otomatis (legend-9pz9), settlement gateway (legend-cs7), refund, payroll.

## Bukti selesai
- `pnpm db:generate` lalu periksa SQL; generate kedua kosong. Test migrasi RLS (`migration-force-rls-guard`, `migration-fk-force-rls`).
- Test gagal-dulu: isolasi tenant/outlet; impor ulang berkas yang sama tidak menggandakan baris; auto-match hanya pada kecocokan jumlah persis dan tanggal dalam toleransi; unmatch mengembalikan keadaan; alert setoran kas muncul tepat sesudah batas hari kebijakan; kasus PIC tercatat per aksi.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file dan tes. Contract root bila `packages/shared` berubah.
- Typecheck api, shared, web lewat `heavy` sekali di akhir; eslint + prettier berkas berubah. Jangan `pnpm check` penuh atau `pnpm test` penuh (jatah merge train).
- Review (Q48, tingkat K): satu subagent `architect` untuk diff gabungan.
- Tulis brief Codex `docs/briefs/271b-second-opinion-cash-bank.md` (xhigh: uang + migrasi), jangan dijalankan.

## Laporan
Sekali di akhir: keputusan desain, per potongan (hasil, SHA), migrasi (`when`, prevId), bukti, file berubah, kontrak untuk UI, kartu baru, risiko, jumlah subagent dan puncak bersamaan.
