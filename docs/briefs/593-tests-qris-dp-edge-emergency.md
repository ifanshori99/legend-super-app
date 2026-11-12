# Brief: test-writer (Claude Sonnet) — test gagal-dulu QRIS ber-DP + tombol darurat edge

## Peran
Baca `~/.agents/team/roles/test-writer.md` dan bagian "Paralel dulu", "Kerja berat" di `~/.agents/team/TEAM.md`.

## Sumber
Desain di `origin/design/qris-dp-edge-emergency` (d4840228): `docs/design/qris-dp-intent.md` (tabel 24 kasus, invarian I1-I6) dan `docs/design/edge-emergency.md`. Kartu: `bd show legend-yhia9.1 legend-bod.1`.
Pertanyaan founder Q92-Q95 masih terbuka (lama QR 5 vs 10 menit, buka kunci manajer, fallback POS, penerima alarm): buat nilai itu parameter/konstanta di test, jangan dikunci di assertion; CTO mengirim jawabannya.

## Kerja
Dua area terpisah, paralel: subagent test-writer per area (file test berbeda), Explore dulu untuk fixture yang ada.
- Cabang `test/qris-dp-intent` (basis `milestone/m1`): test API untuk C1-C3 (kunci tagihan selama QR aktif, satu QR aktif per tagihan, status mati hanya dari penyedia + 60 detik, uang terlambat ke dana tak teralokasi, tidak ada pembayaran ganda tercatat). Tiap invarian I1-I6 punya test; angka Rupiah eksplisit.
- Cabang `test/edge-emergency` (basis `milestone/m1`): sesi penerima PIN (tidak bisa dipakai absen), on-duty, fan-out <=5 detik dengan tanda terima, satu tekanan = satu alarm, sinkron cloud tanpa duplikat, isolasi tenant/outlet, cek Origin WebSocket.

## Bukti selesai
- Semua test merah karena fitur belum ada (bukan karena error setup): tunjukkan lewat `LEGEND_TEST_FILES=... heavy pnpm test`.
- Pra-gate AGENTS.md hijau. Commit + push kedua cabang tanpa --force. Lapor file, jumlah test per invarian/kasus, angka subagent.
