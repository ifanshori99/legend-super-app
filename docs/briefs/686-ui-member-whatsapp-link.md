# Brief: ui-engineer — ajakan hubungkan WhatsApp di layar member (legend-vnvg)

## Peran
Baca `~/.agents/team/roles/ui-engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep, Read offset/limit), lalu ikuti. UI ikut `~/.agents/team/ui-standard.md`.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `milestone/m1`. Cabang akhir `ui/member-whatsapp-link`.

## Tujuan
Founder menyetujui mockup `design/mockups/qr-vnvg-member.html` (W11 Q3). Layar poin/reward member menampilkan ajakan menghubungkan WhatsApp saat `getCurrentAuth.whatsAppVerified` false (bukan empty state generik), menuju `/masuk/hubungkan` (legend-baa, AUTH-07). Sudah terhubung: ajakan hilang. Tugas kecil; boleh tanpa test-writer, tetapi tambah test komponen untuk dua kondisi itu.

## Kartu
`legend-vnvg`. Aturan kartu: `~/.agents/team/brief-template.md`. Teks UI didaftarkan ke katalog.

## Bukti selesai
Screenshot 390 dan 1280 dua kondisi di `docs/screenshots/member-whatsapp-link/`, test hijau, pra-gate AGENTS.md (typecheck web lewat heavy).

## Sebelum melapor
Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Jangan merge, jangan deploy.
