# Brief: engineer — stok opname (legend-j5x)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat), lalu ikuti. Konvensi: `AGENTS.md`, `docs/plan/contracts.md`.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/stock-opname`, cabang `ws/stock-opname` (dari `main`). Setup: `pnpm install --offline --frozen-lockfile` (gagal: `--prefer-offline`); jangan symlink `node_modules`.

## Tujuan
INV-03, PRD v1.7 §3 F16 Stok Opname, §4 Alur J (`docs/PRD.md`): opname penuh dan siklus (cycle), hitung buta (penghitung tidak melihat stok sistem), selisih (variance) per item dengan nilai pakai moving-average cost, persetujuan oleh user berbeda dari penghitung lewat `approval_requests` sebelum posting; entri penyesuaian di ledger stok append-only hanya setelah disetujui. Detail: `bd show legend-j5x`.

## Kartu
`legend-j5x`. Di awal: `ghostex board associate legend-j5x`, `bd update legend-j5x --status in_progress`. Saat melapor: status `review` + `bd comment` bahasa biasa.

## Catatan (stok dan nilai)
- Snapshot stok sistem saat opname dimulai; transaksi selama opname ditangani jelas (freeze lokasi atau hitung delta), pilih satu dan jelaskan.
- Posting idempoten; approval sekali pakai, terikat ke versi hitungan; penghitung tidak boleh menyetujui.
- Kuantitas desimal pasti (bukan float); nilai uang integer IDR.
- Cabang `ws/recipe-bom` dan `ws/procurement` (belum merge) juga menyentuh area inventory: buat file baru (`inventory-count*.ts`), jangan ubah file service mereka; konflik registrasi dirapikan saat merge.
- Tabel baru: `tenant_id` NOT NULL, RLS FORCE, unique termasuk `tenant_id`, punya `outlet_id`. Migration via drizzle-kit, jangan edit `_journal.json`. Jangan baca `.env*`.

## Scope
- Boleh: `apps/api/src/db/schema/inventory-count*.ts`, migration baru, `apps/api/src/services/inventory-count*.ts`, `apps/api/src/routes/inventory-count*.routes.ts`, `apps/api/src/test/inventory-count*.test.ts`, kontrak inventory di `packages/shared`, satu-dua baris registrasi.
- Jangan: `apps/web/`, POS/payment/purchasing/recipe.

## Bukti selesai
- Test: opname penuh dan siklus; hitung buta (stok sistem tidak bocor ke penghitung lewat API); variance dan nilainya; approval oleh user lain; penghitung ditolak menyetujui; ledger hanya setelah approval; posting dobel tidak menggandakan; transaksi selama opname; isolasi tenant/outlet.
- `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs` lulus (satu gerbang penuh setelah perubahan terakhir; jangan ulang run basi). `git status` bersih.
- Subagent reviewer konteks segar cek diff; temuan nyata dibetulkan.

## Sebelum melapor
Commit lokal merujuk `legend-j5x`. Jangan push, jangan merge.

## Laporan
Hasil, bukti, file berubah, commit, bead lanjutan, risiko tersisa.
