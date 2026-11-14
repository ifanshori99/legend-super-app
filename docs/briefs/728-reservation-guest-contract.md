# Brief: engineer (Claude Sonnet) — kontrak tamu reservasi (legend-z5ygw)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md`, lalu ikuti. `bd show legend-z5ygw` untuk detail dan komentar.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree: `git worktree add -b ws/reservation-guest-contract .worktrees/reservation-guest-contract origin/milestone/m1`. Bila `ws/reservation-followups` 905891fa7 menyentuh file yang sama, rebase di atasnya dan catat di laporan.

## Tujuan (satu area, pecah per subagent implementer)
1. DTO view tamu reservasi memuat `timeZone` outlet (prioritas utama: UI sekarang selalu Asia/Jakarta, salah untuk outlet WITA/WIT, termasuk `requestedFor`).
2. DTO memuat hasil keputusan permintaan reschedule (disetujui/ditolak, alasan bila ada).
3. Pada permintaan disetujui, DTO memuat jadwal lama.
4. Guard "terlambat" juga berlaku saat tamu MEMINTA reschedule (bukan hanya saat staf approve); kode error sama dengan guard staf.
Kontrak di `packages/shared` (validator + `types/api.ts`), service + route API, test API. UI hanya disesuaikan bila typecheck web pecah; jangan mendesain ulang layar tamu (cabang `ui/reservation-guest-page` menunggu review founder).
Migrasi: diharapkan tidak perlu. Bila perlu, berhenti dan tanya CTO untuk nomor.

## Tingkat dan review
Tingkat K ringan (data tamu publik): satu subagent `architect` effort high pada diff akhir. Test gagal-dulu wajib (guard terlambat saat diminta, timeZone non-WIB).

## Bukti, sebelum melapor
Test terarah lewat `heavy`, pra-gate AGENTS.md (prettier, eslint, typecheck api+web lewat `heavy`). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan" (sertakan angka subagent). Commit lokal, push cabang tanpa force. Jangan merge, jangan deploy.
