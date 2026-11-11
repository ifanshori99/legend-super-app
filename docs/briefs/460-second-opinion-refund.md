# Brief: second-opinion Codex — area refund + pemulihan order (promo, tukar, voucher)

Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti. Read-only. Effort xhigh (uang).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Basis `origin/milestone/m1` (3c7217b2).

## Cabang (sekali untuk seluruh area)
- `origin/ws/rat9r-voucher-cap` 391a5514 — berisi pti5r (promo refund) 326bfbfa, fwe4l, k0ub4 (item pengganti Rp0) 864efb26, rat9r (voucher + refund <= nilai dibayar, kolom paid_value_idr, migrasi 0235 sementara).
- `origin/ws/ti19m-filing-order` 79923008 — urutan filing monoton di bawah lock intent (Codex 423 P1).

## Aturan founder
W4 Q25: total voucher tukar + refund untuk satu item <= yang dibayar tamu. Prinsip: jangan sampai ada pihak dibayar lebih atau outlet rugi.

## Fokus
Jalur yang membayar lebih dari nilai dibayar (refund parsial berulang, tukar berantai, voucher sistem/staf, re-report, rejected lalu tukar, race dua staf, retry/idempotensi), porsi promo/diskon salah dibagi, pajak/service saat refund, urutan filing, RLS/akses approval. Sudah dikartu, cukup konfirmasi: refundPosOrder abaikan voucher (legend-5g9sn), voucher maaf staf tanpa batas (legend-eajpb), preview harga daftar + tukar lama (legend-pqm3t).

## Laporan
Temuan P0..P3: file:baris, skenario (input -> hasil salah), saran. Sebut yang bersih. Angka subagent.
