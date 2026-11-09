# Brief 264b: second opinion untuk area KDS (remake/comp, potong stok, migrasi 0180 dan 0184)

Belum dijalankan. CTO memulainya setelah cabang masuk antrean dan sebelum gerbang rilis (satu kali per area).

## Peran

Baca `~/.agents/team/roles/second-opinion.md` dan `~/.agents/team/TEAM.md`.

- Read-only: jangan ubah kode, jangan commit.
- Langkah pertama: pecah tugas, lalu spawn subagent paralel dalam satu giliran.
- Dua run terpisah (A dan B), satu akun Codex per run. Tiap run hanya membaca diff miliknya; berkas lain boleh dibuka untuk konteks.

## Repo

- Cabang `ws/kds-issues-station`, worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/kds-issues-station`, HEAD `038d8201`, basis `d8ea5e0b`.
- Cabang `ws/kds-capacity-rules` (di atas `038d8201`), worktree `.worktrees/kds-capacity-rules`. HEAD isi dari laporan engineer (kartu legend-w4nq4 dan legend-44jm).
- Ringkasan kartu: legend-d60m (satu bentuk `order_issues`), legend-4b5 (log remake/comp, migrasi 0180), legend-0eq7 (proyeksi nama), legend-tsp5 (station-summary), legend-rutl (tableLabel dan channel), legend-w4nq4 (tabel `kitchen_capacity_rules`, migrasi 0184), legend-44jm (GET capacity-rules).
- Konteks: PRD §3 F12 dan F41, KDS-05, KDS-07, R25, ORD-09; `docs/PROGRESS.md` bagian "WS-04 KDS issues dan stasiun".

## Run A: remake/comp, refund ditolak, potong stok, migrasi 0180

Perintah:

```
git diff d8ea5e0b 038d8201 -- apps/api/drizzle/0180_order_issues.sql apps/api/drizzle/meta apps/api/src/db/schema/kds-issues.ts apps/api/src/db/schema/kds-issues.custom.sql apps/api/src/services/order-issues.service.ts apps/api/src/services/recipe-deduction.service.ts packages/shared/src/inventory/recipe-bom.ts packages/shared/src/kitchen/schemas.ts packages/shared/src/qr-order/schemas.ts
```

Pertanyaan khusus:

1. Refund manual lewat `reportOrderIssue` ditolak 422 setelah cek izin. Adakah jalur lain (SQL langsung, QR resolve, event) yang menyimpan `manual_refund` tanpa persetujuan terpakai (R25, ORD-09)?
2. Comp hanya di baris yang sudah di-void, dan potong stok lewat event `order_issue.recorded` dengan kunci `order_issue:${issueId}`. Adakah jalan stok terpotong dua kali (sale `order.paid` plus comp, remake ganda, kirim ulang event, baris di-void lalu dipulihkan)? Adakah jalan stok tidak terpotong sama sekali?
3. Unique index parsial comp `(tenant_id, order_item_id) WHERE type='comp' AND status<>'cancelled'` dan unique `(tenant_id, idempotency_key)`: lengkap untuk balapan, termasuk kunci sama dengan isi berbeda dan status `cancelled`?
4. Migrasi 0180: RLS tenant dan outlet FORCE, FK komposit inline, CHECK, rantai `prevId` snapshot dari 0166, `when` 1794259000000 lebih besar dari entri sebelumnya.
5. `voucherId` dan `replacementItemId` tanpa FK atau cek kepemilikan (kartu legend-o8quo): seberapa parah sebelum kartu itu selesai?
6. Biaya bahan 0 bila tanpa resep atau lokasi penjualan: apakah bisa dimanfaatkan untuk menyembunyikan biaya?

## Run B: station-summary, header tiket, capacity rules, migrasi 0184

Perintah:

```
git diff d8ea5e0b 038d8201 -- apps/api/src/services/kds.service.ts apps/api/src/services/kds-support.ts apps/api/src/routes/kds.routes.ts packages/shared/src/kitchen/endpoints.ts
git diff 038d8201 ws/kds-capacity-rules -- apps/api packages/shared
```

Pertanyaan khusus:

1. `getStationSummary` dan `tableLabel`/`channel` di tiket: bocor lintas tenant atau outlet? Pemanggil khusus stasiun hanya melihat stasiunnya?
2. `kitchen_capacity_rules` (0184): RLS tenant dan outlet FORCE, FK komposit ke stasiun, CHECK sama dengan kontrak, rantai `prevId` dari 0180, `when` 1794263000000.
3. PUT mengganti seluruh daftar satu stasiun dalam satu transaksi: apakah dua PUT bersamaan bisa menyisakan daftar campuran atau kosong? Izin yang dipakai benar untuk pengelola KDS?
4. GET: urutan stabil, tak pernah mengembalikan stasiun tenant atau outlet lain.

## Keluaran

Satu berkas hasil per run (`264b-second-opinion-kds.resultA.md`, `.resultB.md`), temuan nyata saja: berkas:baris, skenario gagal, saran perbaikan. Tanpa pujian.
