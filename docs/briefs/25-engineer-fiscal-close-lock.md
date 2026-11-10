# Brief: engineer — serialisasi tutup/buka periode fiskal (legend-72we)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti. Konvensi: `AGENTS.md`, `docs/plan/AGENT_PLAYBOOK.md`, `docs/plan/contracts.md`.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/fiscal-close-lock`, cabang `ws/fiscal-close-lock` (dari `main`). Jangan pindah cabang.

## Tujuan
ACC-02 (PRD §3.19, `docs/PRD.md`): tutup dan buka ulang periode fiskal satu badan hukum (legal entity) harus berurutan. Ambil kunci database per legal entity (pola advisory lock `hashtextextended` seperti `pos-shift.service.ts` bila ada, atau `SELECT ... FOR UPDATE`) sebelum memeriksa urutan periode dan mengambil snapshot. Posting jurnal ke periode yang sedang ditutup juga harus terserialisasi dengan penutupan. Detail: `bd show legend-72we`.

## Kartu
`legend-72we`. Di awal: `ghostex board associate legend-72we` dan `bd update legend-72we --status in_progress`. Saat melapor: `bd update legend-72we --status review` dan `bd comment legend-72we "<ringkasan bahasa biasa>"`.

## Catatan
- Area uang: plan singkat dulu. Cari service akuntansi/periode lewat subagent Explore.
- Bila perlu migration: drizzle-kit, jangan edit `_journal.json` manual; cabang lain memakai 0063–0065, nomor dirapikan saat merge.

## Scope
- Boleh: service/route/schema akuntansi periode fiskal dan jurnal di `apps/api`, test terkait.
- Jangan: `apps/web/`, `design/`, file POS dan payment.

## Bukti selesai
- Test integrasi konkuren dengan PostgreSQL nyata: close vs reopen bersamaan, close vs posting bersamaan, dua close bersamaan; hasil deterministik, tidak ada snapshot yang tidak konsisten, isolasi antar legal entity dan tenant (lock satu entity tidak memblokir entity lain).
- `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs` lulus. `git status` bersih.
- Subagent reviewer konteks segar cek diff; temuan nyata dibetulkan.

## Sebelum melapor
Commit lokal di `ws/fiscal-close-lock`, pesan merujuk `legend-72we`. Jangan push, jangan merge.

## Laporan
Hasil, bukti, file berubah, commit, risiko tersisa, kebutuhan dari CTO.
