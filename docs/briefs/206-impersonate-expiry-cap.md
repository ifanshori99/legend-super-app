# Brief: engineer — sesi impersonate dipotong saat grant berakhir, findImpersonationGrants dipersempit (legend-npkpz)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/impersonate-expiry-cap` dari `integ/m1-batch24` 94d769c6 (berisi ws/impersonate-grant 162bd645; gate penuh sedang jalan). Worktree `.worktrees/impersonate-expiry-cap`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge. Bila m1 sudah memuat 94d769c6 saat lapor, rebase ke m1.

## Tujuan
`legend-npkpz` (P3, tingkat K: auth). Lanjutan legend-rzirp:
1. Sesi impersonated dibatasi 60 menit, tetapi tidak dipotong saat grant berakhir lebih cepat (guard per request sudah menolak, sesi tetap hidup). Potong `expiresAt` sesi ke min(60 menit, grant.expiresAt) saat impersonate dimulai; cabut grant atau grant kedaluwarsa tetap ditolak guard per request.
2. `findImpersonationGrants` memeriksa semua tenant bergiliran (sekitar 3 kali saat mulai, 1 kali saat selesai). Persempit ke tenant tempat admin punya grant aktif sebelum cek peran, tanpa mengubah hasil.
3. Label UI audit untuk `support_access.impersonation_started` dan `support_access.impersonation_ended` (teks i18n di pemetaan label audit yang sudah ada; tanpa layar baru).
Detail: `bd show legend-npkpz`, `bd show legend-rzirp`, `bd show legend-cg071` (MFA opsi (a): tidak ada bypass MFA).

## Kartu
`ghostex board associate legend-npkpz`, `bd update legend-npkpz --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: `lib/auth.ts` hook impersonate, layanan grant support, pemetaan label audit dan teks i18n-nya, test. Jangan: skema/migrasi, middleware support-session selain yang perlu, refund, pos-day, edge, payroll, `worker-main.ts`.

## Bukti selesai
Test reproduksi gagal dulu: grant berakhir 10 menit lagi, sesi impersonated kedaluwarsa dalam 10 menit, bukan 60; grant lebih panjang dari 60 menit tetap dibatasi 60; jumlah query tenant saat mulai turun tanpa mengubah keputusan izin (test perilaku, bukan hitung query bila rapuh); label audit tampil. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c 'cd <worktree> && pwd && ...'` + nullglob dengan jumlah file jalan; test root hanya lewat `pnpm test`. tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier. Jangan jalankan `pnpm check` penuh. Review K: reviewer Opus + architect paralel. Brief Codex `docs/briefs/206b-second-opinion-impersonate-expiry-cap.md` di folder utama (tidak di-commit).

## Laporan
Sekali: hasil, bukti, file berubah, SHA, risiko tersisa. Jangan menunggu proses global. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
