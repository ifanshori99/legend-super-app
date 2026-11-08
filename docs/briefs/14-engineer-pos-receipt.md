# Brief: engineer — legend-93a

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti. Konvensi: `AGENTS.md`, `docs/plan/AGENT_PLAYBOOK.md`, `docs/plan/contracts.md`. Prosedur migration: `/Users/ifanshori99/Projects/legend super app/HANDOFF.md` §5.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/pos-receipt`, cabang `ws/pos-receipt` (dari `main` terbaru). Jangan pindah cabang.

## Tujuan
Selesaikan bead `legend-93a` sesuai deskripsi dan acceptance-nya (`bd show legend-93a`) dan PRD (`docs/PRD.md`) bagian yang dirujuk. Area uang: nomor struk gapless per outlet/device, aman offline, tanpa duplikat.

## Kartu
`legend-93a`. Di awal: `ghostex board associate legend-93a` dan `bd update legend-93a --status in_progress`. Saat melapor: `bd update legend-93a --status review` dan `bd comment legend-93a "<ringkasan bahasa biasa>"`.

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
Commit lokal, pesan merujuk `legend-93a`. Jangan push, jangan merge.

## Laporan
Hasil, bukti, file berubah, commit, migration (nomor), bead lanjutan, risiko, kebutuhan dari CTO.
