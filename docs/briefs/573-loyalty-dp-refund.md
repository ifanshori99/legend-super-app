# Brief: engineer (Codex) — refund DP retur + sisa DP reservasi (legend-77r0, legend-fug4)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu", "Kerja berat" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit). Konteks area: `docs/briefs/567-loyalty-money.md` dan `docs/briefs/567-loyalty-money-cards.md`.

## Repo
Worktree dari Ghostex basis `ws/loyalty-money` (b579a379). Buat cabang `ws/loyalty-dp`. Commit lokal, push cabang boleh. Migrasi bila perlu: nomor **0411-0413** saja.

## Kartu dan keputusan founder (`bd memories founder-q80-q82`)
1. legend-77r0: test deposit refund promo + pindahkan `livePromoApplicationOf` ke port. **Q81**: retur barang dari pesanan ber-DP: bagian DP direfund ke pembayar DP lewat metode asal (bukan saldo, bukan tunai ke orang lain). Bagian DP dihitung proporsional dan dibulatkan ke bawah untuk outlet tidak rugi; total refund tidak pernah melebihi DP yang benar-benar dibayar dikurangi refund DP sebelumnya.
2. legend-fug4: sisa DP reservasi di atas tagihan. **Q82**: sisa jadi saldo pelanggan HANYA bila profil pelanggan terhubung DAN tagihan akhir sah (lunas, tidak void). Selain itu: ditahan sebagai kewajiban refund manual (kasir/manajer refund ke pembayar), tidak hilang dan tidak otomatis jadi saldo.

## Uang — wajib (Jangan sampai rugi)
Test gagal-dulu untuk tiap aturan: tidak ada pihak dibayar lebih (refund ulang, retur berulang, retur + void, race dua kasir, idempotency key diulang); jurnal seimbang; sisa DP tidak bisa dicairkan dua kali (saldo + refund manual). Ragu: pilih aturan yang membatasi, lapor ke CTO.

## Review
Setelah selesai: SATU subagent architect effort xhigh (uang) mereview diff; temuan nyata dibetulkan. Kamu sendiri kerja di effort high.

## Bukti selesai
- Test terarah lulus (`LEGEND_TEST_FILES=... heavy pnpm test`), typecheck api, `db:generate` kosong bila ada migrasi.
- Jangan jalankan `pnpm check` penuh; jangan sentuh milestone/m1 atau main; jangan deploy.
- Tutup kartu yang terbukti; lapor SHA, test, temuan architect.
