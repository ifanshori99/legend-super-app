# Brief: engineer — legend-6c0

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti. Konvensi: `AGENTS.md`, `docs/plan/AGENT_PLAYBOOK.md`, `docs/plan/contracts.md`. Prosedur migration: `/Users/ifanshori99/Projects/legend super app/HANDOFF.md` §5.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/pos-shift`, cabang `ws/pos-shift` (dari `main` terbaru). Jangan pindah cabang.

## Tujuan
Selesaikan bead `legend-6c0` sesuai deskripsi dan acceptance-nya (`bd show legend-6c0`) dan PRD (`docs/PRD.md`) bagian yang dirujuk. Area uang: blind count, variance, approval, end-of-day harus atomik dan teraudit.

## Kartu
`legend-6c0`. Di awal: `ghostex board associate legend-6c0` dan `bd update legend-6c0 --status in_progress`. Saat melapor: `bd update legend-6c0 --status review` dan `bd comment legend-6c0 "<ringkasan bahasa biasa>"`.

## Cepat
Founder minta cepat. Pecah kerja dan spawn subagent bertipe (implementer, test-writer, Explore) paralel dalam satu giliran; file tidak bertumpuk. Jangan menunggu tanpa kerja.

## Catatan paralel
Tiga engineer lain bekerja paralel di cabang lain (POS shift kasir, nomor struk, hardening edge, provisioning role DB). Bila butuh migration: generate dengan drizzle-kit seperti biasa; nomor bisa bentrok saat merge, CTO yang menangani urutan (jangan edit `_journal.json` manual). Jangan sentuh file di luar domain bead.

## Scope
- Boleh diubah: kode, test, dan docs domain bead ini.
- Jangan disentuh: `apps/web/src/routes/_customer/` (UI order pelanggan sedang dibangun), `design/`, provisioning role DB. Rahasia: jangan baca `.env*`.

## Bukti selesai
- Test baru untuk perilaku nyata, isolasi tenant, dan kasus gagal.
- `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs` lulus. `git status` bersih.
- Subagent reviewer konteks segar atas diff; temuan nyata dibetulkan.

## Sebelum melapor
Commit lokal, pesan merujuk `legend-6c0`. Jangan push, jangan merge.

## Laporan
Hasil, bukti, file berubah, commit, migration (nomor), bead lanjutan, risiko, kebutuhan dari CTO.
