# 1172 Akses: audit status outlet, kunci peran kustom, jam DB, kunci IP (engineer, 19 Nov)

Peran: `~/.agents/team/roles/engineer.md`. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (test-writer per kartu, implementer hb1u9 dan z2kaf paralel, v8dfx lalu hzdy5 berurutan oleh satu implementer).
Template kerja: `docs/briefs/_TEMPLATE-workstream.md`. Langkah 0 worktree: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`.

Base: `milestone/m1`. Cabang kerja: `ws/1172-access-audit-guard`. Tingkat K (akses): architect effort xhigh sebelum lapor. Tanpa migrasi.

## Kartu (baca `bd show <id>`)
1. `legend-hb1u9` `org.service.ts:~557` `setOutletStatus` belum menulis audit. Tambah `recordAudit` `outlet.status_changed` (aktor, tenant, outlet, status lama/baru) dalam transaksi yang sama. Test: ubah status -> satu baris audit; gagal -> tanpa audit.
2. `legend-v8dfx` `access.service.ts:~378` `updateCustomRole`: ambil `pg_advisory_xact_lock` kunci `legend:role-assignment-end:<tenant>` di awal (pola ada di `:~835`). Test barrier dua koneksi: ubah peran kustom bersamaan dengan akhiri penugasan tidak meninggalkan izin basi.
3. `legend-hzdy5` SESUDAH v8dfx (file sama): jalur grant, end, dan `platform-tenant-owner.service.ts` memakai `clock_timestamp()` DB, bukan jam aplikasi atau `now()` transaksi. Test: urutan waktu grant/end konsisten di transaksi panjang.
4. `legend-z2kaf` kunci rate limit pakai helper `clientIpKey` (sudah di m1) di `edge/link-server.ts`, `routes/staff-pin-sync.routes.ts`, `routes/edge-bootstrap.routes.ts`, `routes/mcp.routes.ts`. JANGAN sentuh rute `payment-webhook`. Test: dua IP berbeda tidak berbagi kuota; header proxy palsu tidak menggeser kunci (TRUST_PROXY tetap ditolak).

## Batas
- Jangan sentuh: `payment-webhook*`, `platform-approval.service.ts`, `edge-order-redrive.job.ts`, `pos-receipt*`, `order-given.ts`, `reservation-*`, `accounting-journal*`.
- Tanpa migrasi. Bila ternyata perlu: berhenti dan lapor ke CTO untuk nomor (0708+).

## Bukti selesai
Test gagal-dulu per kartu (terarah lewat `heavy`), typecheck api lewat `heavy` sekali, prettier + eslint file berubah, `db:generate` kosong. Commit dan push ke cabang kerja.

## Laporan
SHA, kartu selesai, jumlah subagent dan puncak bersamaan, hasil gate, temuan architect dan fixnya, yang belum teruji.
