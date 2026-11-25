# Review uang C4a (b1cb567e1, 26 Nov): TIDAK LULUS, 0 P0, 4 P1

Path relatif ke `apps/api/src/`.

1. **P1** `services/accounting-bank-matching.ts:99-111`: jurnal settlement tetap kandidat bebas; mutasi lain senominal bisa cocok (otomatis/manual) dan uangnya tak pernah dibukukan. Fix: `NOT EXISTS` match `gateway_settlement` dengan `ref_id = je.source_id` bila `je.source_type='gateway_settlement'`; sesudah unmatch jurnal bebas lagi. Test otomatis + manual.
2. **P1** `services/payment-settlement-emit.service.ts:148`: dobel dengan jalur lama. Jurnal manual yang diposting sesudah impor membiarkan mutasi `unmatched`, lalu emit mendebit bank lagi. Fix: tolak bila ada jurnal bebas di GL bank, dalam toleransi tanggal, senilai mutasi atau salah satu net. Test.
3. **P1** `services/payment-settlement-emit.service.ts:261`: kasus bank `written_off` tidak memblokir; kliring yang sudah dihapus bisa dikredit lagi. Fix: tambah `written_off`. Test.
4. **P1** `test/payment-settlement-emit.test.ts:290-332`: event ke jurnal wajib dites (AJ-SET `test/accounting-auto-journal.test.ts:3948` memakai envelope buatan). Kirim baris outbox asli 2 outlet ke consumer: seimbang, jumlah debit bank = mutasi, kliring = gross, replay = satu jurnal.
5. **P2, kartu ini** `services/accounting-gateway-recon.service.ts:133`: mutasi 2 outlet tampil selisih palsu yang bisa memicu write-off. Pakai `bankStatementLineMatches.amountIdr`; test 2 outlet.
6. **P2, kartu** `services/payment-settlement-emit.service.ts:225-231`: fee hanya dicek terhadap laporan; fee 90% lolos bila net = mutasi. Perlu batas per metode, wajib sebelum rilis C4b.
7. **P2, kartu** `services/accounting-bank-recon-stale.service.ts:57`: pembalikan jurnal settlement (fee 0) tidak menandai match stale.
8. **P3, kartu ini (test)**: satu settlement ke dua mutasi bersamaan; tenant lain; unmatch multi-outlet.
9. **P3** mapping `bank` berubah antara emit dan posting = debit akun lain.

Aman: emit ganda, urutan kunci, RLS, izin ganda, unmatch tidak bisa emit ulang, refund dipotong dari payout = ditolak.

Keputusan CTO: 1, 2, 3, 4, 5, 8 dan komentar basi `settlement-events.ts` dibetulkan di cabang; 6, 7, 9 jadi kartu (6 memblokir C4b).

## Re-review 26 Nov (4262ca419): LULUS, 0 P0/P1

Sisa (jurnal gross/gabungan net, batas atas jendela) ke kartu legend-osqou.44, memblokir C4b.

## Review uang 26 Nov bundel .42/.43/.44 (f2283612a): LULUS, 0 P0-P2

P3 (kartu, sebelum C4b dirilis): batas fee maksimal 1000 bps (`payment-settlement-emit.service.ts:334`); pembulatan fee `Math.floor`, bukan `ceil` (:421); satu config saja: outlet bila barisnya ada (nonaktif = tolak), tenant hanya bila outlet tidak ada (:349-359, 386-399); batas "hari ini" pakai `shiftDate(todayOf(now), 1)` agar outlet WITA/WIT tak bercelah (:362-368, 452); unmatch sebelum posting: sertakan baris penolakan settlement itu di cek perubahan mapping (`accounting-auto-journal-amounts.ts:1897-1911`).
