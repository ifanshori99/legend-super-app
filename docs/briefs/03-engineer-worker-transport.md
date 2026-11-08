# Brief: engineer — legend-18qw worker event transport dan gap replay

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (kerja berat, definisi selesai), lalu ikuti. Aturan repo yang mengikat: `docs/plan/AGENT_PLAYBOOK.md`, `docs/plan/contracts.md`. Baca juga `/Users/ifanshori99/Projects/legend super app/HANDOFF.md` bagian 2 (aturan tetap: claude-mem mati, Colima untuk `pnpm check`/`pnpm test`, jangan push).

## Repo
Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/worker-transport`, cabang `ws/worker-transport` (dari `main`, sudah dibuat, `.claude/settings.local.json` pematik claude-mem sudah ada). `cd` ke sana dulu dan kerja hanya di folder itu. Pakai `PORT` dan nama database sendiri bila menjalankan server.

## Tujuan
Tutup penghalang rilis P1 `legend-18qw` (`bd show legend-18qw`): transport event edge/cloud yang terautentikasi, acknowledgement idempoten yang tahan lama, replay urutan yang hilang, plus adapter penerima/provider notifikasi produksi untuk worker. Saat ini config produksi sengaja gagal tertutup tanpa ini, jadi di production tidak ada event outbox yang terkirim (notifikasi, payment.paid, approval).

## Masukan
- PRD `docs/PRD.md` §3 (shared outbox) dan §5 (Worker).
- Bead terkait selesai: `legend-fzkl` (registry tenant worker, wiring adapter produksi).
- Ragu soal desain (auth transport, skema ack, idempotensi): konsultasi subagent `architect` dulu, catat keputusannya di `docs/DECISIONS.md`.
- Provider notifikasi nyata (WA/email) belum ada kontraknya (bead EXT). Buat adapter di balik interface + config, dengan test memakai fake; jangan butuh kunci asli.

## Scope
- Boleh diubah: kode worker, API, dan paket bersama yang dibutuhkan transport/outbox, migrasi bila perlu, test-nya, `docs/DECISIONS.md`, `docs/deployment.md` (bagian env baru), `.env.example` (nama key saja).
- Jangan disentuh: `apps/web/src/features/ws03-*` (UI pelanggan sedang didesain ulang), `design/**`.

## Bukti selesai
- `pnpm check` dan `pnpm test` hijau (Colima nyala via `~/.claude/scripts/colima-up`; perintah berat lewat `heavy`). Jalankan lewat subagent `test-runner`.
- Test baru untuk: auth ditolak, ack idempoten (kirim ulang tidak dobel), gap replay (sequence bolong terisi), worker produksi tidak lagi gagal tertutup bila config lengkap.
- Review subagent `reviewer` sebelum melapor, temuan nyata dibetulkan.
- `bd close legend-18qw` hanya bila semua di atas lulus; follow-up jadi bead baru.

## Sebelum melapor
Commit lokal di cabang worktree. Pesan merujuk `legend-18qw`. Jangan merge ke main, jangan push.

## Laporan
Hasil, keputusan desain utama, bukti (perintah dan hasil), file berubah, commit, migrasi (ya/tidak), env baru, risiko tersisa, bead follow-up.
