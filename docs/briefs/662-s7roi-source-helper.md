# 662 s7roi: satu helper rekening sumber payout aktif

Worktree `.worktrees/fin-exc-662`. Test gagal-dulu: `apps/api/src/test/payroll-payout-source-active.test.ts` (jangan ubah assertion; bila salah, lapor).

## Peta
- `services/payroll-payout-gl.service.ts` `sourceBankOverride` (~L113-146): tanpa filter `isActive`. Dipakai settle (~L224 optional, ~L237) dan repost (~L537).
- `services/payroll-payout-overpaid.service.ts` salinan inline (~L193-214): tanpa `isActive`; fee dicatat `feeIdr: 0` (~L244), jurnal hanya `payout_overpaid` dengan `amounts: {netIdr}` (~L217-232).
- `services/payroll-payout-setup.ts` `sourceAccountUsable` (L58-84): satu-satunya yang memfilter `isActive`; dipakai `assertManualPayoutSetup` (approve, export download, repost fee). Role `bank_charges` lewat `accountMappings` (`bankChargesMapped` L38-55), akun 8101.

## Kerja
1. Satu helper (di `payroll-payout-setup.ts` atau berkas kecil baru) yang me-resolve rekening sumber AKTIF (is_active=true, tenant sama) dan mengembalikan glAccountId; gagal tertutup: lempar `payoutRefuse`/`HttpError` 409 `PAYOUT_SOURCE_ACCOUNT_MISSING` dengan pesan jelas untuk finance (repost: tertahan, sebut perlu rekening aktif). Tunai tetap `undefined`. Ganti ketiga salinan memakai helper itu; `sourceAccountUsable` jadi pembungkus tipis atau dihapus.
2. Overpaid: jurnal biaya transfer (nilai fee sama dengan yang dipakai jalur settle, bawaan Rp5.000, kebijakan PT) ke role `bank_charges` (8101) Dr, kredit rekening sumber (bank 1103 = net + fee), tepat sekali (idempotensi pada kunci jurnal yang sudah ada, aman dengan dua laporan bersamaan). Gaji/net karyawan tidak berubah. Catat `feeIdr` sesungguhnya di baris payout item bila kolomnya ada.
3. Uang: tidak boleh ada fee ganda, tidak boleh posting ke rekening nonaktif. Bila `bank_charges` tidak termapping di jalur overpaid: gagal tertutup dengan pesan jelas (ikut aturan jalur settle).

## Bukti
Test file di atas hijau semua; test payroll-payout lain yang tersentuh tetap hijau (`LEGEND_TEST_FILES=... heavy pnpm test`). Jangan sentuh berkas di luar tiga service di atas dan test-nya.
