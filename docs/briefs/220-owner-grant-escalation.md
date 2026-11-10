# Brief: engineer — template Owner hanya bisa diberikan oleh owner (legend-7vsby)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/owner-grant-escalation` dari `ws/receipt-writeoff-hardening` c4c347ef (legend-l56xd, sudah antre di merge train; merge train akan cherry-pick commit cabang ini). Worktree `.worktrees/owner-grant-escalation`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
`legend-7vsby` (P1, tingkat K auth, gerbang rilis). `packages/shared/src/access/grants.ts:116-125`: saat target template owner, otoritas puncak dilewati, tetapi pemberi yang memegang semua izin Owner tetap boleh memberikannya. Rantai: admin tenant membuat custom role C berisi semua kode Owner, memberi C ke akun B, lalu B memberi template owner ke A. Tidak ada owner yang terlibat; bertentangan dengan komentar `grants.ts:39-41` dan menembus batas owner-only write-off (l56xd) serta semua cek template owner lain.
Perbaikan: di `assertCanGrantRole`, bila target `templateKey === 'owner'`, wajibkan pemberi memegang penugasan template owner tenant yang aktif (bukan sekadar izin yang sama). Tolak juga `pos.receipt.writeoff` (dan kode khusus owner lain bila ada daftarnya) di custom role lewat `normalizeCustomRolePermissions`, dengan pesan yang jelas; periksa dampaknya pada data lama (custom role yang sudah menyimpan kode itu: cukup diabaikan saat dibaca, jangan merusak daftar peran). Keputusan founder Q41 (admin tenant boleh mengatur semuanya) tidak mencakup membuat Owner baru: Owner tetap hanya dari Owner.

## Kartu
`ghostex board associate legend-7vsby`, `bd update legend-7vsby --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: `packages/shared/src/access/grants.ts`, normalisasi custom role, service/route grant peran bila perlu, test. Jangan: migrasi, write-off service selain yang perlu, refund, payroll, support/impersonate (legend-c9kbk, cabang lain), `worker-main.ts`, UI.

## Bukti selesai
Test reproduksi gagal dulu di basis: rantai admin tenant, custom role berisi semua kode Owner, lalu pemberian template owner menghasilkan 403; owner asli tetap bisa memberi Owner; custom role baru dengan `pos.receipt.writeoff` ditolak; custom role lama yang menyimpannya tetap terbaca. Test akses dan write-off lama tetap lulus. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c 'cd <worktree> && pwd && ...'` + nullglob dengan jumlah file jalan; test shared ikut dijalankan. tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier. Jangan jalankan `pnpm check` penuh. Review K: reviewer Opus + architect paralel. Tulis brief Codex `docs/briefs/220b-second-opinion-owner-grant-escalation.md` di folder utama (tidak di-commit).

## Laporan
Sekali: hasil, bukti, file berubah, SHA, risiko tersisa. Jangan menunggu proses global. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
