# Brief 1103: engineer, perbaikan refund ronde 10 (tingkat K uang)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md`, lalu ikuti. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Worktree
`/Users/ifanshori99/Projects/legend super app/legend-2ad4d9ab`, cabang `ws/1072-refund-ronde6-q45` (head 013b83cec). Tanpa migrasi (0697 tetap bebas; bila ternyata perlu, lapor dulu). Push tanpa `--force`.

## Masukan
- Laporan SO: `docs/qa/second-opinion-refund-ronde10-1101.md` (F1-F6).
- Invarian: `docs/briefs/1072-invarian.md`. Founder Q45: refund otomatis penyedia MATI di rilis 1.

## Keputusan CTO (sudah diambil, jangan tanya lagi; aturan yang membatasi pembayaran)
1. Persempit jalur matched saat saklar refund DOIT mati (menutup F2, F3, F6 di rilis 1):
   - Ekspor `refundProviderSwitchedOff` dari `apps/api/src/services/payment-refund-gateway.ts:136`.
   - Di `processRefundEvent` (`apps/api/src/services/payment-webhook.service.ts`), sebelum cabang invalid (~:1885) dan sebelum updater (~:1960): bila saklar mati, sukses bertanda tangan pada jalur matched (cocok kunci, refund id, settle manual finance; BUKAN cocok payment-object) tidak lewat logika echo/ID buatan/alias, tetapi mengajukan satu hold CONFLICT per event tersimpan (tanpa refund id, nilai penuh `max(intent, evidence)`). CONFLICT hanya bisa ditutup `not_this_intent`: tidak membuat fakta, jurnal, atau refund.
   - Hapus `legacyProviderRefundIds` dari jalur alias.
   - F6: hold mismatch diberi kunci tetap (hash R + intent pemilik + T2), bukan event id tersimpan.
2. F4 + F5 diperbaiki di recorder (`apps/api/src/services/payment-provider-partial-refund.ts`), karena refund manual finance tetap sampai ke sana: insert yang konflik/`same_as_counted`/exceeds-left (~:382-397, :425-439, :895-920) dan laporan melebihi hold -> panggil `fileTransactionConflictHoldInTx` (menaikkan hold terbuka ke nilai lebih besar; hold lama sudah selesai -> hold surplus I7 baru). Jangan blokir finance menghitung hold tanpa refund id.
3. F1 fail-closed: insert konflik tanpa baris berkunci sama -> hold CONFLICT dengan `holdEventId("\0kind\0"+kind)`, bukan `return` diam (~:1494).
4. Jangan matikan hold atau potongan kredit DP.
5. Suite matched lama (1075, 1077, 1088) diset `DOIT_REFUNDS_ENABLED=true` supaya tetap menguji jalur aktif.

## Pembagian paralel
- implementer A: butir 1 (webhook service). implementer B: butir 2+3 (recorder). Berkas terpisah.
- test-writer: `apps/api/src/test/refund-1101-*.test.ts` skenario F1-F6 dari laporan, gagal-dulu di 013b83cec; test saklar mati = tidak ada fakta/jurnal/refund baru, hanya hold.
- test-runner (pemegang token heavy): test terarah 1101 + 1075/1077/1088 + regresi refund, typecheck API sekali.
- architect subagent effort xhigh: review diff akhir (uang).

## Bukti selesai
Test 1101 merah di 013b83cec, hijau di head; regresi refund hijau; typecheck API; prettier/eslint berkas berubah; `pnpm db:generate` kosong.

## Laporan
Hasil per temuan F1-F6, berkas, commit, head SHA, risiko. Buat bead: saklar refund DOIT nyala kembali membuka F1-F3/F6 (wajib rancang ulang sebelum dinyalakan). Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.` Catatan rilis: cek DB target 0 baris kind `invalid_report` sebelum rilis.
