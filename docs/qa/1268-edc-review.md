# Review K uang: ws/1268-edc a42f230fd (basis b268e4c24), legend-9yw78.15 dan .17

Reviewer: architect subagent (Opus), konteks segar, 26 Nov. Read-only; test TIDAK dijalankan oleh reviewer.

## Putusan: TIDAK LULUS tipis. 0 P1, 2 P2 menahan, 4 P3.

Terpenuhi: kunci advisory slip setelah kunci tagihan (urutan aman, tanpa deadlock antar tagihan; READ COMMITTED melihat baris yang sudah commit setelah kunci didapat); normalisasi sama dengan `holdsSlip` di resolve, dan regex kontrak `[A-Za-z0-9-]` membuat strip+upper sudah lengkap; tolak 409 me-rollback pemakaian override (test); catatan ditulis sebelum tolak untuk nominal beda, ref tidak valid, tagihan tak terbaca; server tetap aman karena `override.valueIdr === remaining` (nominal slip tidak bisa dibukukan beda dari sisa). Test lama yang diubah tidak menyembunyikan bug: `112233445566 -> ...77` perlu karena cek slip kini mendahului cek override; `storing nothing -> never storing it` sesuai desain baru (catatan wajib ada), dan `money()` kosong tetap diperiksa.

## Menahan

1. **P2 nomor kartu tetap tersimpan di server.** `components/payment/edc-standalone.tsx` `submit()` meminta persetujuan SEBELUM record dengan `reason: t("posKasirEdc.standalone.reason", { ref: bankRef.trim() })` ("EDC standalone, referensi bank {ref}"). `canSubmit` hanya cek panjang >= 6, dan `overrideReasonSchema` (`packages/shared/src/access/override.ts:188`) tanpa saringan PAN. Kasir mengetik 4111111111111111: PAN masuk `pos_overrides.reason`, audit, dan event `pos_override.recorded` ke cloud. `keptRef` di `api.ts` hanya melindungi localStorage; test web tidak melewati langkah override.
   Perbaikan: di `submit()`/`canSubmit` tolak dengan `posStandaloneEdcSchema.shape.bankRef.safeParse(bankRef.trim())` sebelum `override.mutateAsync` (teks galat field, tanpa catatan; aman karena belum ada permintaan yang tercatat). Pertahanan server: refine `!/\d{13,19}/` (setelah buang `-` dan spasi) pada reason override `edc_standalone`, 400. Test: komponen/`requestEdcApproval` tidak pernah mengirim PAN; API menolak reason ber-PAN.
2. **P2 beda bank melewati pagar.** `pos-edc-standalone.ts` menyaring `edcTransactions.bank = terminal.bankCode` dan kunci `edc-slip:${bankCode}:${slip}`. Outlet dengan EDC BCA + Mandiri: slip BCA yang sudah membayar tagihan A bisa dicatat lagi untuk tagihan B dengan memilih terminal Mandiri. Rekonsiliasi baru menangkapnya belakangan (barang sudah keluar). Sesuai "ragu = tolak": hapus filter bank dan bank dari kunci (se-tenant). Biaya salah tolak (RRN kembar lintas bank) hanya gesekan: tagihan terkunci, supervisor resolve. Test: slip bank X ditolak di terminal bank Y.

## P3 (kartu lanjutan, tidak menahan)

3. Baris ECR `pending`/`unknown` tagihan lain biasanya `rrn` NULL: slip dari mesin yang sebenarnya approved tidak tertangkap. Andalkan rekonsiliasi; catat di kartu.
4. `slipLocked` hanya saat `record.isError`; field masih bisa diubah saat `record.isPending`, dan terminal/kode approval/mode tidak dikunci. Kunci juga saat pending dan semua field yang masuk signature.
5. Cek slip berjalan sebelum override diverifikasi: 409 vs 403 membuka probing "slip ini sudah dipakai" tanpa PIN supervisor. Kecil; urutan bisa dibalik bila tidak mengubah rollback.
6. Scan tenant tanpa indeks dengan fungsi di `rrn` di bawah kunci; indeks ekspresi `(tenant_id, upper(replace(rrn,'-','')))` saat ada migrasi berikut (sudah dicatat implementer).

## Bukti yang belum dijalankan

`LEGEND_TEST_FILES="src/test/pos-edc-standalone.test.ts src/test/pos-payment-intent-resolve.test.ts" heavy pnpm test` (api) dan `heavy vitest run apps/web/test/pos-payment-intent.test.ts`, termasuk test balapan `[201, 409]`.

## Keputusan CTO 26 Nov
Perbaiki P2 no. 1 (cek bankRef sebelum override + server tolak alasan berisi deret 13-19 digit) dan no. 2 (slip unik se-tenant, tanpa filter bank). Dari P3: kunci field slip selama kirim. P3 lain dicatat di bead .15 (indeks = kartu 0529 lanjutan).
