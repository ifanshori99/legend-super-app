# Brief: engineer (Claude Sonnet) — backend QRIS ber-DP (legend-yhia9.2-.4)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu", "Kerja berat" di `~/.agents/team/TEAM.md`. Tingkat K uang. Aturan founder "Jangan sampai rugi" berlaku.

## Sumber
- Desain: `docs/design/qris-dp-intent.md` di `origin/design/qris-dp-edge-emergency` (d4840228). Kartu C1-C3: `bd show legend-yhia9.2 legend-yhia9.3 legend-yhia9.4`. Titik TBD-verify di desain dicek dulu.
- Keputusan founder Q92-Q95: `bd memories founder-q92-q95` (QR 5 menit, buka kunci manajer PIN 30 menit setelah kedaluwarsa + audit).
- Test gagal-dulu sudah ada di cabang basis: baca bagian "Assumptions" di header tiap file test dan helper `pos-qris-hold-test-helpers.ts` sebelum menamai apa pun; samakan nama/bentuk body dengan test kecuali ada alasan kuat (catat di laporan).

## Repo
Worktree basis `test/qris-dp-intent` (63c9354d). Cabang `ws/qris-dp-hold`. Migrasi **0419-0421** saja.

## Kerja
C1 (tabel `pos_qris_holds`, trigger kunci tagihan, satu QR aktif per tagihan) → C2 (status mati hanya dari penyedia + 60 detik, `handlePosPaymentClosed` sadar kunci, pembayaran lewat `confirmPayment` dengan urutan kunci legend-s0u8c, uang terlambat ke dana tak teralokasi) dan C3 (backend layar pelanggan: pairing 6 digit, tagihan dipilih kasir, isi dihitung server) paralel setelah C1. Satu implementer per kartu, file terpisah.
UI (legend-astv2) dan sandbox (legend-1yig6) bukan bagian brief ini. QRIS ber-DP di UI tetap ditahan.

## Bukti selesai
- Test di cabang basis hijau: `LEGEND_TEST_FILES="<5 file pos-qris-* + pos-customer-display>" heavy pnpm test`. Assertion tidak dilonggarkan.
- Pra-gate AGENTS.md hijau, `db:generate` kosong. Satu subagent architect effort xhigh (uang + migrasi).
- Commit + push tanpa --force. Jangan merge. Lapor SHA, angka subagent, perubahan dari asumsi test.
