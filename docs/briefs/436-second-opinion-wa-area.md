# Brief: second-opinion Codex — area WhatsApp masuk (identitas, reset PIN, login tersamar, retensi)

Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti. Read-only: jangan edit, jangan commit.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Basis pembanding `origin/milestone/m1`. Desain: `git show origin/ws/kirimdev-inbound-design:docs/design/whatsapp-inbound-verification.md`.

## Cabang yang direview (sekali untuk seluruh area)
- `origin/ws/lgfru-wa-proof` 9b41cc6d — A: bukti WA masuk (webhook Kirimdev, tantangan, kode), migrasi 0272.
- `origin/ws/s5rgo-wa-simulator` 52a10a81 — D: simulator lokal.
- `origin/ws/9h2oj-wa-reset` 66b99671 — B: reset PIN slip gaji lewat WA, hapus OTP lama, migrasi 0273.
- `origin/ws/w8dfz1-wa-masked` b5956fdb — login pelanggan nomor tersamar + confirm/cancel.
- `origin/ws/w8dfz2-wa-retention` dfd6f1bb — job retensi data WA (hapus bertahap).
- `origin/ws/5opkl-identity-test-isolation` c19a1f3f — isolasi test identitas (test saja).

## Fokus
Akses dan identitas: pengambilalihan akun lewat nomor, replay/tebak kode, webhook tanpa tanda tangan sah, kebocoran antar tenant (RLS), batas laju per IP/nomor, race tantangan selesai ganda, PIN baru tanpa cek identitas ulang, data pribadi di log, job retensi menghapus yang belum waktunya. Migrasi 0272/0273: aman di data yang sudah ada.

## Laporan
Temuan berurut P0..P3: file:baris, skenario konkret (input -> hasil salah), saran perbaikan. Sebut yang sudah dicek dan bersih. Angka subagent: total, puncak bersamaan.
