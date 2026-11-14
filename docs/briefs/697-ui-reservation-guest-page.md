# Brief: ui-engineer — halaman tamu kelola reservasi (legend-g12il)

## Peran
Baca `~/.agents/team/roles/ui-engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep, Read offset/limit), lalu ikuti. Semua kerja UI ikut `~/.agents/team/ui-standard.md`.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `ws/reservation-followups` bila sudah terdorong, selain itu `ws/reservation-reschedule`. Cabang akhir `ui/reservation-guest-page`.

## Tujuan
Founder menyetujui mockup (W18 Q14, 14 Nov): `design/mockups/` di cabang `design/reservation-guest` 259f61f9f, 16 keadaan, desktop 1280 + mobile 390. Bangun halaman publik tamu dari link token di pesan reservasi: lihat detail, minta reschedule, batal dengan rincian DP dipotong/dikembalikan sebelum konfirmasi, link tidak berlaku, permintaan ditolak/disetujui.

Server yang sudah ada: `apps/api/src/services/reservation-public.ts`, `reservation-reschedule.ts`. Celah kontrak dicatat di `legend-z5ygw` (tamu melihat hasil keputusan reschedule; reschedule terlambat ditolak saat diminta). Bangun UI dengan mock untuk bagian yang belum ada di server, beri tanda jelas di laporan; jangan ubah server. Keadaan "terlambat untuk reschedule": founder W3 Q13 (14 Nov) memutuskan reschedule terlambat ditolak; tamu tetap datang di jadwal asli atau batal dengan DP hangus.

Nominal DP dihitung server; UI hanya menampilkan nilai dari API, tidak menghitung sendiri.

## Kartu
`legend-g12il` (aturan kartu: `~/.agents/team/brief-template.md`). Teks UI baru didaftarkan ke katalog (`node --test tests/text-contract.test.mjs`).

## Bukti selesai
Screenshot tiap keadaan 1280 dan 390 (`docs/screenshots/reservation-guest/`), ui-auditor sebelum lapor, test web terkait hijau, pra-gate AGENTS.md (prettier, eslint, typecheck web lewat heavy).

## Sebelum melapor
Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Jangan merge, jangan deploy.
