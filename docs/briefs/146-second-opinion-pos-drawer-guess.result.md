# Hasil Codex 146: second opinion POS drawer guess (G1634, 9 Nov 15:20)

Empat rentang sampai `42e94ce7` di `ws/pos-drawer-guess`, 3 subagent paralel, reproduksi dengan fungsi asli dan mock query. Run 4 tanpa temuan baru. Belum diuji: integrasi DB, migrasi, e2e.

## Temuan
- **P1, `apps/api/src/services/pos-shift.service.ts:1270`**: oracle saldo lewat validasi hitungan basi. Setelah count, `cash_out X` lalu `cash_in X` menghasilkan 403 bila out normal, tetapi 409 `SHIFT_COUNT_STALE` bila held, tanpa approval sah. Ikat count ke watermark setiap mutasi kas.
- **P1, `apps/api/src/services/pos-shift.service.ts:1423`**: held kas manual menciptakan kas fiktif. expected=counted Rp100.000 dan cash_out held Rp150.000 tanpa pencairan menghasilkan debit kas Rp150.000 saat tutup; kompensasi pembukuan hanya untuk koreksi yang sudah dibukukan.
- **P1, `apps/api/src/services/pos-shift.service.ts:601`**: batas outflow mengabaikan refund/void. Refund held Rp1.000 dari shift terdahulu lalu cash_out `MAX_SAFE_INTEGER` diterima, tetapi total held membuat count dan force-count selalu gagal. Batasi gabungan seluruh outflow pada semua writer tanpa bergantung status held.
- **P2, `apps/api/src/services/pos-shift.service.ts:1108`**: matriks approval kosong melewati penolakan chain lama bernominal. Approval HP lama masih bisa dipakai setelah admin menghapus policy. Validasi `amountIdr === null` dan payload numerik sebelum shortcut tanpa policy.
