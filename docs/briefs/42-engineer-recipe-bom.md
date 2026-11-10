# Brief: engineer — resep/BOM dan potong stok otomatis (legend-db6)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti. Konvensi: `AGENTS.md`, `docs/plan/AGENT_PLAYBOOK.md`, `docs/plan/contracts.md`. Prosedur migration: `/Users/ifanshori99/Projects/legend super app/HANDOFF.md` §5.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/recipe-bom`, cabang `ws/recipe-bom` (dari `main`). Jangan pindah cabang.

## Tujuan
INV-02, PRD v1.7 §3 F16 Pemotongan Otomatis, F17 Resep Bertingkat, F27 Duty Meal (`docs/PRD.md`): resep bertingkat (sub-resep), varian/modifier, konversi UOM, potong stok real-time atau saat tutup hari (pengaturan per outlet), duty meal dan comp. Mengonsumsi event `order.paid`, `day.closed`, `remake`; ledakan multi-level; idempoten per event (event yang sama tidak memotong dua kali). Pakai ledger stok append-only dan moving-average cost dari legend-98t. Detail: `bd show legend-db6`.

## Kartu
`legend-db6`. Di awal: `ghostex board associate legend-db6` dan `bd update legend-db6 --status in_progress`. Saat melapor: `bd update legend-db6 --status review` dan `bd comment legend-db6 "<ringkasan bahasa biasa>"`.

## Catatan
- Lewat event saja; jangan ubah `pos-order.service.ts` (cabang KDS dan lain sedang mengubahnya). Bila event yang dibutuhkan belum ada, catat sebagai bead lanjutan dan uji dengan event sintetis.
- Kuantitas desimal pakai tipe numerik yang pasti (bukan float); nilai uang integer IDR.
- Migration: drizzle-kit, jangan edit `_journal.json`; nomor dirapikan saat merge. Rahasia: jangan baca `.env*`.

## Scope
- Boleh: `apps/api/src/db/schema/inventory*.ts` / `recipe*.ts`, migration baru, `apps/api/src/services/inventory*.ts` / `recipe*.ts`, consumer event, routes inventory resep, test `apps/api/src/test/recipe*.test.ts` / `inventory*.test.ts`, kontrak `packages/shared`.
- Jangan: `apps/web/`, `design/`, POS/payment/KDS/purchasing.

## Bukti selesai
- Test: resep 3 tingkat, modifier menambah/mengganti bahan, konversi UOM, mode real-time vs tutup hari, event dobel tidak memotong dua kali, remake, duty meal/comp tercatat terpisah, isolasi tenant/outlet.
- `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs` lulus. `git status` bersih.
- Subagent reviewer konteks segar cek diff; temuan nyata dibetulkan.

## Sebelum melapor
Commit lokal di `ws/recipe-bom`, pesan merujuk `legend-db6`. Jangan push, jangan merge.

## Laporan
Hasil, bukti, file berubah, commit, bead lanjutan, risiko tersisa.
