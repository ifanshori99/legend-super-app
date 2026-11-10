# Brief lanjutan G4oo4: pasang penarik PIN cloud ke edge dan sisa t9ii

## Cabang
Cabang baru `ws/edge-pin-pull` dari `ws/edge-pin-sync` e420469e, worktree `.worktrees/edge-pin-pull`, `worktree:setup`. `ws/edge-pin-sync` tidak diubah lagi (masuk merge train setelah verifikasi CTO). Jangan push, jangan merge.

## Tujuan (tingkat K)
1. `legend-yvhw8` (P1): penarik staff-pin-records belum terpasang di runtime edge; `applyStaffPinRecords` tidak dipanggil di produksi, jadi reset/pencabutan PIN di cloud tidak sampai ke edge. Pasang dengan cursor `spin2`, aturan generasi t9ii, dan backoff yang sama dengan puller lain.
2. `legend-kgbw` (P3): set PIN edge yang ditolak cloud tidak diekspor ulang ke edge; edge tetap memegang PIN yang ditolak.
3. `legend-rucdm` (P2): cap kunci generasi PIN hanya untuk kunci yang ditolak cloud; jam edge mundur saat offline.
4. `legend-4z2ch` (P3): `idle_in_transaction_session_timeout` + alert horizon ekspor PIN (`sync_xid`) bila ringan; bila butuh infra, tulis di runbook saja.
Detail: `bd show <id>`.

## Scope
Sama dengan brief 183 (`edge/runtime.ts` hanya untuk mendaftarkan puller; catat). Jangan sentuh urutan struk (`receipt_sequences`: agent lain).

## Bukti selesai
Test reproduksi gagal dulu (reset PIN di cloud sampai ke edge; PIN edge yang ditolak cloud diganti nilai cloud). `LEGEND_TEST_FILES` lewat `bash -c 'cd <worktree> && pwd && ...'` + nullglob dengan jumlah file jalan; test root hanya lewat `pnpm test`. tsc lewat `heavy` sekali per perbaikan, eslint, prettier; tanpa `pnpm check` penuh. Review K: reviewer Opus + architect paralel, perbaikan terakhir dibaca ulang. Brief Codex `docs/briefs/188b-second-opinion-edge-pin-pull.md` di folder utama (tidak di-commit). Migrasi: `when` di atas 1794230000000.

## Laporan
Sekali setelah semuanya selesai. Jangan menunggu proses global. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
