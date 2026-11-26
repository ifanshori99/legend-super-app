# Review K X2 impor settlement EDC CSV (ws/1272-x2 17ff2affc)

Reviewer: architect (Opus, xhigh), 27 Nov. Baca kode saja. Hasil: **LULUS dengan catatan**, 0 P1, 3 P2, 4 P3. P2 wajib dibetulkan sebelum gabung; cek CTO tanpa review ulang kecuali diff menyentuh resolve.

## Aman
- Impor hanya memanggil `resolveEdcReconciliation` outcome `approved` pada baris approved; nominal/status tidak berubah; ECR `unknown` tidak pernah di-approve.
- Satu baris bank = satu transaksi (set `claimed` + unique parsial `matched_txn_key`).
- Idempoten: hash file, row key, advisory lock per outlet. Akses: 404 lintas tenant/scope, `payment.reconcile` + MFA, RLS, append-only.
- Parser menolak sen, notasi E, RRN non-alfanumerik; kolom PAN tidak dibaca. Assertion `pos-day.test.ts` benar.

## P2
1. `edc-settlement-import.service.ts:287-296`: baris void tidak alert/mismatch. Void untuk sale approved (sudah clear atau belum) = mismatch + alert `void`.
2. `:197-211`, `:271-274`, schema `:239`: `row_key` unik untuk semua status, baris `unmatched` tidak bisa dicocokkan ulang. Unique parsial `WHERE match_status <> 'unmatched'`.
3. `:135`, schema `:186-190`: hash tanpa bank. Hash `bank|csv`.

## P3
4. `:356-381`: clear hanya bila tender hidup (paling ketat).
5. `:297-321`: alert TID tak terdaftar digabung per impor; mismatch nominal dalam file yang sama menahan clear seperti void.
6. Parser `:240-257`: cek jumlah sel per baris; terima `Rp 55.000,-`.
7. `shift-api.ts:170-180` (UI Tutup Hari): Rp 0 per terminal sebelum file bank, `receiptIdr` tidak tampil, `standaloneUnmatched` terlalu luas. Masuk bead legend-wasr7.18 (UI X2).

## Keputusan CTO 27 Nov
P2 1-3 dan P3 4-6 dibetulkan sekarang dengan test gagal-dulu. P3 7 ke wasr7.18. Kolom CSV per bank masih tebakan: verifikasi dengan contoh berkas asli dari founder sebelum gerbang rilis (dicatat di daftar founder).
