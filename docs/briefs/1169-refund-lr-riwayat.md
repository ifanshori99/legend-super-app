# 1169 Refund POS: riwayat selaras largest remainder (engineer, 19 Nov)

Peran: `~/.agents/team/roles/engineer.md`. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore jalur riwayat + test-writer + implementer).
Template kerja: `docs/briefs/_TEMPLATE-workstream.md`. Langkah 0 worktree: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`.

Base: `ws/1095-void-refund-ganda-voucher` (4bfae8476, SIAP batch96). Cabang kerja: `ws/1169-refund-lr-riwayat`. Landing sesudah batch96. Tingkat K (uang): architect effort xhigh sebelum lapor.

## Kartu
`legend-rle3t` (SO 1166 P2, laporan `docs/qa/second-opinion-refund-kasir-ronde5-1166.md` di folder utama).
- Masalah: batas refund POS yang menyebut item memakai bagian largest remainder (`order-given.ts:414-446`, `pos-order-corrections.ts:1286-1312`), tetapi pembacaan riwayat (`order-given.ts:473-488`) membagi nominal tersimpan dengan floor lalu sisa ke item terakhir. Satu baris bisa terdebit melebihi bagiannya, baris lain punya ruang semu Rp1, voucher berikut mengambil bagian baris ketiga. Hasil bergantung urutan item.
- Keputusan CTO (arah membatasi bayar): tanpa migrasi. Pembacaan riwayat memakai alokasi deterministik yang sama dengan batas: bagi nominal refund ke item yang disebut secara largest remainder atas bagian baris, tie-break ID, urutan item di request tidak berpengaruh, tiap debit dijepit sisa bagian baris, jumlah debit = nominal refund. Bila jepitan menyisakan nominal, sisanya ke baris lain yang disebut dan masih punya ruang (tetap tidak melebihi bagian).

## Test (gagal-dulu)
1. A 10.000 / B 20.001 / C 30.000, service 3.000, PBJT 6.300, dibayar 69.301. Voucher C Rp1, refund `[A,B]` Rp34.651 diterima, lalu voucher A Rp1 ditolak 422 `APOLOGY_VOUCHER_NOTHING_DUE`; ruang A dan B sama-sama 0.
2. Sama dengan urutan `[B,A]`: hasil identik.
3. Beberapa pasangan baris lain + voucher/refund bersamaan dengan barrier dua koneksi: total keluar <= dibayar, tiap baris <= bagiannya.
4. Batas cakupan SO: test langsung guard chain 422 pada void kas sesudah charge keluar dari `paid` (status, movement, event ter-rollback); kontrol chain bersaldo nol tetap sukses.

## Batas
- Jangan sentuh: `payment-webhook.service.ts`, `reservation-*`, `platform-approval.service.ts`, `payroll-payout-*`, `edge-order-redrive.job.ts`, `pos-points.service.ts`.
- Tanpa migrasi. Bila ternyata perlu: berhenti dan lapor ke CTO untuk nomor (berikutnya 0708+).

## Bukti selesai
Test terarah lewat `heavy`, typecheck api lewat `heavy` sekali, prettier + eslint file berubah, `db:generate` kosong. Commit dan push ke cabang kerja.

## Laporan
SHA, kartu selesai, jumlah subagent dan puncak bersamaan, hasil gate, temuan architect dan fixnya, yang belum teruji.
