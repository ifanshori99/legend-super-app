# Brief: engineer — edge PIN membedakan DB edge yang dibangun ulang lewat instance_id (legend-o839h)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/edge-pin-instance` dari `integ/m1-batch24` 94d769c6 (berisi ws/edge-pin-pull dan ws/edge-restore-detect; gate penuh sedang jalan, m1 akan maju ke sana). Worktree `.worktrees/edge-pin-instance`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge. Bila m1 sudah memuat 94d769c6 saat lapor, rebase ke m1.

## Tujuan
`legend-o839h` (P2, tingkat K: PIN dan migrasi). Kini edge yang DB-nya dibangun ulang dengan node id sama: set PIN ditolak sampai sequence melewati yang tersimpan, dan hanya ditutup runbook (daftar sebagai node baru). Simpan instance id edge (`edge_nodes.instance_id`, dari legend-zsdd, sudah di m1) di samping `generation_edge_node_id`/`generation_edge_sequence`; bila instance berbeda, kembali ke perbandingan kunci, bukan sequence. Edge lama tanpa instance id tetap memakai perilaku sekarang. Detail: `bd show legend-o839h`, `bd show legend-yvhw8`, `bd show legend-yd0h8`.

## Kartu
`ghostex board associate legend-o839h`, `bd update legend-o839h --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: alur pull/apply PIN edge (staff PIN sync), skema kolom generasi PIN, migrasi `0157` dengan when `1794236000000` bila wajib (0155 payroll, 0156 write-off struk; catat), test. Jangan: urutan struk edge (`receipt_sequences`), refund, payroll, pos-day, auth Better Auth, `worker-main.ts`.

## Bukti selesai
Test reproduksi gagal dulu: DB edge dibangun ulang dengan node id sama dan instance baru, set PIN diterima tanpa runbook; instance sama dengan sequence mundur tetap ditolak; edge lama tanpa instance id berperilaku seperti sekarang; lintas tenant tidak bocor. `db:generate` kosong sesudah migrasi. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c 'cd <worktree> && pwd && ...'` + nullglob dengan jumlah file jalan; test root hanya lewat `pnpm test`. tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier. Jangan jalankan `pnpm check` penuh. Review K: reviewer Opus + architect paralel. Brief Codex `docs/briefs/203b-second-opinion-edge-pin-instance.md` di folder utama (tidak di-commit).

## Laporan
Sekali: hasil, bukti, file berubah, SHA, migrasi dan langkah rilis, risiko tersisa. Jangan menunggu proses global. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
