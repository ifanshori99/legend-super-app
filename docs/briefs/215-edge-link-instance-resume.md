# Brief: engineer — link edge mengenali instance baru sesudah rebuild DB (legend-nd3cu)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/edge-link-instance-resume` dari `ws/edge-pin-instance` e1100258 (legend-o839h, sudah di merge train batch27). Worktree `.worktrees/edge-link-instance-resume`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
`legend-nd3cu` (P1, gerbang rilis, tingkat K). Temuan Codex 203b atas o839h: `apps/api/src/edge/db-link-store.ts:295` hanya meneruskan instance baru ke applier; cursor/resume link tetap per node+arah. Sesudah rebuild DB edge dengan cursor cloud 10, antrean baru edge mulai dari link-seq 1: koneksi ditutup 1008; ketika head mencapai 10, semua event baru di-ack tanpa dikirim. PIN tidak pernah sampai ke applier, jadi klaim "runbook tidak perlu lagi" belum benar.
Perbaikan: tangani pergantian instance di state/resume link sebelum `hello` (cursor per instance, atau reset/rebase cursor saat instance berganti), pertahankan fallback lama untuk edge tanpa instance, dan pastikan tidak ada event yang di-ack tanpa diterapkan. Sampai cabang ini masuk, runbook lama (daftarkan edge hasil rebuild sebagai node baru) tetap berlaku: perbarui runbook di cabang ini sesuai hasil akhir.

## Kartu
`ghostex board associate legend-nd3cu`, `bd update legend-nd3cu --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: `edge/db-link-store.ts`, `edge/link-server.ts`, `edge/link-client.ts`, `edge/protocol.ts` (tetap kompatibel dengan edge lama), runbook edge, test. Migrasi hanya bila cursor perlu kolom instance: berhenti dan lapor dulu, CTO memberi nomor. Jangan: applier PIN selain yang perlu, `edge-device-sync.ts` (cabang lain), receipt, refund, payroll, auth, `worker-main.ts`, UI.

## Bukti selesai
Test regresi lewat link nyata (bukan hanya applier) gagal dulu di basis: rebuild DB dengan node id sama, cursor cloud di depan, event PIN baru sampai ke applier dan diterapkan sekali; tidak ada close 1008 berulang; edge lama tanpa instance tetap seperti sebelumnya; tenant lain tidak terpengaruh. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c 'cd <worktree> && pwd && ...'` + nullglob dengan jumlah file jalan. tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier. Jangan jalankan `pnpm check` penuh. Review K: reviewer Opus + architect paralel. Tulis brief Codex `docs/briefs/215b-second-opinion-edge-link-instance-resume.md` di folder utama (tidak di-commit).

## Laporan
Sekali: hasil, bukti, file berubah, SHA, langkah rilis (urutan cloud vs edge), risiko tersisa. Jangan menunggu proses global. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
