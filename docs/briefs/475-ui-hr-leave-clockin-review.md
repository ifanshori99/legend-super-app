# Brief: ui-engineer — layar tinjauan HR: absen masuk saat cuti disetujui (legend-3jem1)

## Peran
Baca `~/.agents/team/roles/ui-engineer.md`, `~/.agents/team/ui-standard.md`, dan bagian "Paralel dulu" + "Kerja berat" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang `ws/3jem1-hr-leave-review-ui` dari `origin/milestone/m1` (3c7217b2) di `.worktrees/3jem1`. Gabungkan juga cabang API yang sudah review: 9y6ri + 5nt2z (3a3750ed), 7o3hd/em8y2 bila belum di m1 (cek `git branch -r --contains`).

## Kartu
`legend-3jem1` (`bd show legend-3jem1`). Awal: `bd update legend-3jem1 --status in_progress`. Lapor: `--status review` + `bd comments add`.

## Sumber desain (disetujui founder Q2, 11 Nov)
Mockup `origin/ws/design-hr-leave-clockin` ab253ad5: 10 keadaan x 1280/390 (lihat README di folder mockup cabang itu, brief designer 444). Bangun sesuai mockup; baca gambar satu layar saat membangun layar itu.

## Batas
Hanya web (`apps/web`) + kontrak shared bila kurang; jangan ubah logika API cuti/absensi (sudah direview). Celah API yang ditemukan: catat sebagai kartu bd, jangan dibetulkan sendiri.

## Paralel
2 Explore (pola layar HRIS yang ada + endpoint/DTO cuti-absensi), implementer per layar/keadaan (maks 4), test-writer Playwright untuk alur utama, ui-auditor 1280 dan 390 sebelum lapor.

## Bukti selesai
Screenshot tiap keadaan 1280 + 390 (path di laporan), Playwright alur utama hijau, typecheck web heap 6144, eslint+prettier file berubah, ui-auditor bersih, commit+push. Laporan: commit, path screenshot, angka test, angka subagent (total, puncak, pemegang heavy).
