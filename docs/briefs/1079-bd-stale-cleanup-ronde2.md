# Brief: qa — pembersihan kartu bd basi ronde 2 (18 Nov)

## Peran
Baca `~/.agents/team/roles/qa.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Langkah pertama: spawn subagent paralel dalam satu giliran.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, read-only atas kode. TANPA worktree. Jangan checkout, jangan edit kode. Bukti dari `git grep`/`git show origin/milestone/m1:<path>` dan `git merge-base --is-ancestor <sha> origin/milestone/m1` (jalankan `git fetch origin milestone/m1` dulu).

## Tujuan
`bd ready` berisi ~390 kartu non-epic, tapi pemilih kartu CTO (ronde 3-4) tidak menemukan yang siap: banyak kartu sudah selesai di m1, sudah dikerjakan di cabang lain, atau duplikat. Bersihkan supaya `bd ready` jujur.

## Metode
- Ikuti metode `docs/qa/2026-11-09-bd-stale-cleanup.md` (ronde 1). Explore per 20-25 kartu, maks 8 Explore bersamaan.
- Tutup (`bd close <id> --reason "<bukti: sha/path:baris di m1>"`) hanya bila bukti jelas kode ada di `origin/milestone/m1`, atau duplikat persis kartu lain yang masih terbuka.
- Sudah dikerjakan di cabang belum landing (`docs/merge-queue.md`, `git branch -r --contains`): JANGAN tutup; `bd comment <id> "kerja ada di <cabang> <sha>, tunggu landing"` lalu `bd update <id> --status review`.
- Ragu: biarkan terbuka, beri komentar singkat bila ada temuan sebagian.
- Kandidat dari pemilih kartu CTO: legend-arp35 (bill-page sudah split langsung), legend-316 (brief 252), legend-hpze7 (allocatePickupCall di pos-order.service.ts:966, sisa keputusan), legend-a6aq6 dan legend-vzvok (di ghostex/1027-guard-http-perangkat-bersama).
- Kartu uang/akses: tutup hanya bila test yang dimaksud kartu ada dan lulus di m1 (cek nama test di m1); jangan jalankan test berat.

## Hasil
Tulis `docs/qa/2026-11-18-bd-stale-cleanup.md` (format ronde 1: ditutup + bukti, status review + cabang, komentar sebagian, angka). Commit HANYA berkas itu (path-scoped: `git commit -m ... -- docs/qa/2026-11-18-bd-stale-cleanup.md`), jangan push main.

## Laporan
Angka (dinilai, ditutup, review, komentar), daftar kartu yang tersisa benar-benar SIAP (prasyarat di m1, tanpa gerbang founder, tanpa tabrakan cabang aktif: refund ws/1072, kas ghostex/cek-kas-1102-*, edge ws/1073-*, int/batch89-90) dikelompokkan jadi usul workstream 3-6 kartu.
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
