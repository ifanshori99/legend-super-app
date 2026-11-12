# Brief: second opinion (Codex) — area uang loyalty/DP/refund

## Peran
Baca `~/.agents/team/roles/second-opinion.md` dan bagian "Kuota Codex dan second opinion" di `~/.agents/team/TEAM.md`. Read-only: jangan ubah kode.

## Cakupan
`git diff f4e1950b...72bf7b71` (cabang `ws/loyalty-dp`, berisi ws/loyalty-money). Isi: celah waktu jurnal peta akun payout vs service charge/pajak (legend-48ft7), poin per PT (founder Q80), port refund promo (legend-77r0), refund DP retur (Q81), sisa DP reservasi jadi saldo atau kewajiban refund manual (Q82), migrasi 0403-0405 + 0411. Keputusan founder: `bd memories founder-q80-q82`, `bd memories founder-q58`.

## Fokus (Jangan sampai rugi)
- Ada pihak dibayar lebih? Refund DP > DP dibayar dikurangi refund sebelumnya; retur berulang; retur + void; sisa DP cair dua kali (saldo + refund manual); idempotency key diulang; race dua kasir.
- Pembulatan: selalu menguntungkan outlet, tidak pernah membuat jumlah negatif.
- Jurnal seimbang di tiap jalur, termasuk pembalikan; peta akun dipilih pada waktu transaksi, bukan waktu baca.
- Poin: tidak bisa lintas PT; klaim edge tetap mati (Q58).
- Saldo: hanya outlet asal (v1); profil tidak terhubung atau tagihan tidak sah = ditahan.
- Migrasi: FORCE RLS, FK, aman di DB berisi data tanpa BYPASSRLS.
- Otorisasi endpoint refund manual: siapa boleh, batas outlet, audit.

## Hasil
- Tiap temuan nyata: `bd create --type=bug --priority=<0-2> --labels=second-opinion,money` dengan file:baris, skenario gagal (angka Rupiah), saran.
- Lapor: daftar kartu, ringkas keparahan, area bersih, area yang tidak sempat dicek.
