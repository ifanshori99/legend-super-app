# Brief: engineer — PIN edge: race resend, counter replay, lock lama (legend-gauz3, legend-r11j7, legend-lhffb)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/edge-pin-race-fixes` dari `milestone/m1` 94d769c6. Worktree `.worktrees/edge-pin-race-fixes`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
Tiga temuan Codex second-opinion (tingkat K auth, gerbang rilis) di sinkron PIN staf edge. Detail, skenario, dan saran perbaikan ada di berkas hasil Codex; baca dulu:
- `docs/briefs/183b-second-opinion-edge-pin-sync.result.md` — `legend-gauz3` P1: `apps/api/src/edge/staff-pin-resend.ts:74` membaca material tanpa kunci baris, lalu append event; reset B bisa selesai sebelum resend A menambah sequence lebih tinggi, PIN lama aktif lagi. Kunci baris sebelum membaca material/latest event (`device-pin-support.ts:124-155` sudah mensyaratkan row lock).
- `docs/briefs/188b-second-opinion-edge-pin-pull.result.md` — `legend-r11j7` P2: `apps/api/src/services/staff-pin-sync.ts:593` counter cloud `3→0→3` antar pull dianggap replay, tiga kegagalan baru hilang; pakai revision state percobaan/reset. `legend-lhffb` P2: `apps/api/src/edge/access-applier.ts:395` lock lama dari backlog bisa mengunci PIN setelah reset bila jam mundur; tolak lock dengan sequence ≤ sequence set dari asal yang sama.

## Kartu
`legend-gauz3`, `legend-r11j7`, `legend-lhffb`. Di awal: `ghostex board associate <id>` dan `bd update <id> --status in_progress` per kartu. Saat melapor: `bd update <id> --status review` dan `bd comment <id> "<ringkasan bahasa biasa>"`.

## Scope
Boleh: `apps/api/src/edge/staff-pin-resend.ts`, `apps/api/src/services/staff-pin-sync.ts`, `apps/api/src/services/device-pin-support.ts`, `apps/api/src/edge/access-applier.ts`, skema/kontrak sinkron PIN bila perlu, test. Jangan: grant/role (`packages/shared/src/access/grants.ts`, cabang lain), write-off, refund, payroll, support/impersonate, edge link instance (legend-nd3cu, cabang lain), UI.
Butuh migrasi (misal kolom revision): pakai nomor 0163, `when` 1794242000000. Tanpa migrasi lebih baik bila revision bisa diturunkan dari data yang ada.

## Bukti selesai
- Test reproduksi gagal dulu di basis untuk tiap kartu: dua transaksi resend/reset berselang (barrier atau dua koneksi) berakhir dengan PIN baru aktif; counter `3→0→3` tercatat sebagai 3 kegagalan baru; lock backlog dengan sequence ≤ set tidak mengunci PIN baru.
- Test PIN edge lama tetap lulus. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c 'cd <worktree> && pwd && ...'`, sebut jumlah file yang jalan. Bila ada migrasi: sertakan `src/test/edge-received-events-migration.test.ts` dan `src/test/migration-fk-force-rls.test.ts`, dan `db:generate` harus kosong.
- tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier untuk berkas berubah. Jangan jalankan `pnpm check` penuh.
- Review K: subagent reviewer Opus + architect paralel; temuan nyata dibetulkan.
- Tulis brief Codex `docs/briefs/221b-second-opinion-edge-pin-race-fixes.md` di folder utama (tidak di-commit): rentang diff, berkas berisiko, invariant. Jangan sertakan temuan Claude.

## Laporan
Sekali: hasil per kartu, bukti (perintah dan hasil), file berubah, SHA, nomor migrasi bila dipakai, risiko tersisa, jumlah subagent dan puncak bersamaan. Jangan menunggu proses global atau loop sleep; tunggu notifikasi job sendiri. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
