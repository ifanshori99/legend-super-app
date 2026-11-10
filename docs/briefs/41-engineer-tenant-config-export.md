# Brief: engineer — ekspor/impor konfigurasi tenant (legend-34c)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti. Konvensi: `AGENTS.md`, `docs/plan/AGENT_PLAYBOOK.md`, `docs/plan/contracts.md`.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/tenant-config-export`, cabang `ws/tenant-config-export` (dari `main`). Jangan pindah cabang.

## Tujuan
TEN-09, PRD v1.7 §3 F4 Konfigurasi sebagai Data & Template Tenant (`docs/PRD.md`): ekspor konfigurasi satu tenant (modul, role, matriks approval, CoA, pajak, service charge, zona, checklist, loyalty, fasilitas, Wi-Fi, konfigurasi payroll) ke dokumen versi-an, lalu impor ke tenant baru sehingga tenant itu langsung bisa dipakai. Tanpa data transaksi dan tanpa data pribadi. Detail: `bd show legend-34c`.

## Kartu
`legend-34c`. Di awal: `ghostex board associate legend-34c` dan `bd update legend-34c --status in_progress`. Saat melapor: `bd update legend-34c --status review` dan `bd comment legend-34c "<ringkasan bahasa biasa>"`.

## Catatan
- Hanya platform admin (permission terpisah). Impor bersifat atomik (satu transaksi), idempoten, dan memetakan ulang semua id. Dokumen ekspor tidak boleh membawa rahasia (kredensial integrasi, kunci, token) maupun PII karyawan/pelanggan; buktikan dengan test.
- Bila perlu migration: drizzle-kit, jangan edit `_journal.json`; nomor dirapikan saat merge. Rahasia: jangan baca `.env*`.

## Scope
- Boleh: `apps/api/src/services/platform*.ts` / `tenant-config*.ts`, routes platform, schema/migration bila perlu, test `apps/api/src/test/tenant-config*.test.ts`, kontrak `packages/shared`.
- Jangan: `apps/web/`, `design/`, modul POS/payment/KDS/purchasing (hanya dibaca untuk ekspor).

## Bukti selesai
- Test: ekspor tenant contoh → impor ke tenant kosong → tenant baru lulus pemeriksaan siap-pakai; ekspor tidak berisi rahasia/PII; impor gagal di tengah tidak meninggalkan sisa; impor ulang tidak menggandakan; non-admin ditolak; isolasi tenant.
- `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs` lulus. `git status` bersih.
- Subagent reviewer konteks segar cek diff; temuan nyata dibetulkan.

## Sebelum melapor
Commit lokal di `ws/tenant-config-export`, pesan merujuk `legend-34c`. Jangan push, jangan merge.

## Laporan
Hasil, bukti, file berubah, commit, risiko tersisa.
