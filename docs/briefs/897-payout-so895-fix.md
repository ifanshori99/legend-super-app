# 897 Payout: perbaikan second opinion 888+891 (1 P1 + 6 P2)

Cabang baru `fix/payout-so895-897` dari `origin/fix/payout-failed-correction-891` (8f7c91126). Tingkat K uang + migrasi; nomor sementara 0637-0640. Kartu: `legend-klr99` (P1), `legend-v2dco` (P2 bundel).
Sumber: `docs/qa/second-opinion-payout-888-891.md` (berkas:baris, skenario, usul test).

## Keputusan CTO
- P1 wajib: satu bukti bank hanya untuk satu operasi (overpaid, return, atau koreksi), dikonsumsi atomik; dipakai ulang di operasi lain ditolak 409.
- P2 wajib: bukti koreksi tidak bisa dipakai lintas tenant (hash unik global untuk bukti bank, tanpa membocorkan data tenant lain di pesan error); gagal membaca hash kedua = tolak (fail closed), bukan lewat; backfill bukti adil (cursor yang maju melewati baris gagal, baris gagal masuk daftar finance).
- P2 guard role aplikasi (koreksi palsu, jurnal fee salah nilai/akun): tutup bila bisa dengan guard trigger yang memeriksa jurnal nyata (akun dan nominal); bila butuh desain besar, tulis kartu lanjutan dengan alasan, jangan dikerjakan setengah.
- P2 settle historis NULL: jangan diubah (sudah tercatat sebagai batas); cukup pastikan baris baru tidak pernah NULL.

## Bukti selesai
- Test gagal-dulu per temuan di 8f7c91126, lalu hijau; suite payout/GL terarah hijau dengan exit code dari log; test pasangan (registry migrasi, guard) diperbarui.
- Pra-gate AGENTS.md (prettier, eslint, typecheck api+web lewat heavy, `db:generate` kosong).
- Satu subagent architect xhigh atas diff; temuan nyata dibetulkan.
- Push tanpa force. Lapor SHA, migrasi, test merah→hijau, angka subagent. Jangan merge, jangan deploy.
