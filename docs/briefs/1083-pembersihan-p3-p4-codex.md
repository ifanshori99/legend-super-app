# Brief: engineer Codex — pembersihan P3-P4 (9 kartu, tingkat S)

Peran: engineer (baca `~/.agents/team/roles/engineer.md`). Codex `gpt-6.1-sol` high. Selesaikan dalam SATU giliran; jangan berhenti di tengah untuk menunggu.
Worktree: worktree Ghostex milikmu (base `milestone/m1`). Langkah 0: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`. Tanpa migrasi.
Codex tidak menjalankan `bd`: tulis ringkasan per kartu di laporan; CTO memindah status.

Kartu (baca deskripsi lengkap: `/Users/ifanshori99/Projects/legend super app/legend/docs/qa/2026-11-18-bd-stale-cleanup.md` bagian 6 dan `bd show` lewat CTO bila perlu):
1. legend-ahgg quiet hours lintas DST (apps/api notification/delivery.ts:86) + test.
2. legend-gatdy hapus `outletId as never` x3 (loyalty-earn-consumer.ts) dengan tipe yang benar, tanpa ubah perilaku.
3. legend-rfsqf format Rp di escpos.ts:128 + test.
4. legend-9zc3 readyAt recall di mock KDS.
5. legend-vv3nc foto fixture website.
6. legend-jwd5k hash menu PDF.
7. legend-bvxs3 timeout S3Client (nilai wajar, dari env bila ada pola env).
8. legend-uqnv error resolver tenant.
9. legend-t5ujz.
Kartu yang ternyata menyentuh uang/akses/migrasi atau butuh keputusan: lewati dan laporkan.
Hindari area aktif: refund (ws/1072), kas (cek-kas-1102), edge (ws/1073), int/batch90.

Tiap perubahan perilaku: test gagal-dulu. Test terarah: `LEGEND_TEST_FILES="..." heavy pnpm test` dari root worktree. Typecheck paket tersentuh sekali lewat `heavy`. Pra-gate AGENTS.md (prettier, eslint).
Commit di cabang `ws/1083-pembersihan-p3`, push tanpa `--force`.
Laporan: hasil per kartu (selesai/dilewati + alasan), bukti test, berkas, commit, cabang. Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
