# 1184 Payout GL: tandai accounting_was_off + lepas payable_account_hold (engineer, 19 Nov)

Peran: `~/.agents/team/roles/engineer.md`. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore area, test-writer per kartu, implementer per kartu di berkas terpisah, reviewer sesudahnya).
Template kerja: `docs/briefs/_TEMPLATE-workstream.md`. Langkah 0 worktree: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`.

Base: `milestone/m1`. Cabang kerja: `ws/1184-payout-gl-holds`. Tingkat K (uang + akses): architect effort xhigh sebelum lapor. Migrasi boleh, rentang **0715-0717** saja; `pnpm db:generate` kosong sesudahnya.

## Kartu (baca `bd show <id>`)
1. `legend-3xzop`: tindakan per posting payout GL `accounting_was_off` -> tandai "sudah masuk saldo pembukaan" tanpa jurnal. Penyetuju Owner atau Finance Manager, step-up password, catatan bukti wajib, audit, pembuat batch tidak boleh menyetujui sendiri. Kode: `apps/api/src/services/payroll-payout-gl.service.ts` (~1695), `db/schema/payroll-payout.ts`.
2. `legend-6qp12` (deskripsi kosong; scope keputusan CTO): jalur melepas baris `payable_account_hold` (~62) dengan aturan sama seperti kartu 1 (Owner/FM, step-up, catatan wajib, audit, tanpa self-approval). Lepas = baris kembali ke antrean jurnal normal sekali saja (idempoten, kunci baris, jam DB); tidak membuat jurnal ganda.
Hanya API + test. Layar finance (`legend-48egz`) butuh mockup: jangan dikerjakan.

## Jangan sampai rugi (wajib test)
- Tandai/lepas dua kali bersamaan (barrier dua koneksi) -> satu sukses, satu ditolak, tanpa jurnal ganda.
- Baris yang ditandai tidak pernah dijurnal lagi; baris dilepas dijurnal tepat sekali.
- Pembuat batch, peran tanpa izin, step-up kedaluwarsa, catatan kosong -> ditolak tanpa efek dan tanpa audit sukses.
- Isolasi tenant: posting outlet/tenant lain tidak bisa disentuh.

## Batas
Jangan sentuh: `payroll-payout-recon.service.ts` dan test `payroll-payout-*lock*` (dipegang cabang 1179), `payment-*`, `reservation-*`, `hris-offboarding.service.ts`, `platform-tenant-owner.service.ts`. Izin baru di `packages/shared/src/permissions.ts` bila perlu (sebut di laporan).

## Bukti selesai
Test gagal-dulu per kartu (terarah lewat `heavy`), test lama payout GL tetap hijau, typecheck api (dan web bila shared berubah) lewat `heavy` sekali dengan exit code, prettier + eslint file berubah. Tunggu job heavy dengan Bash run_in_background; jangan akhiri giliran dengan kabar tunggu. Commit dan push ke cabang kerja. Tutup kartu bd hanya sesudah architect bersih.

## Laporan
SHA, kartu selesai, nomor migrasi dipakai, jumlah subagent dan puncak bersamaan, hasil gate, temuan architect dan fixnya, yang belum teruji. Lapor sekali.
