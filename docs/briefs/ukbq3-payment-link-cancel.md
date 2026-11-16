# legend-ukbq3: pembatalan link bayar mengikuti penyedia

Basis: cabang ws/qris-dp-hold (pola hold/bukti legend-yhia9 C2 di `apps/api/src/services/pos-qris-hold.ts`: cancelPosQris, checkQrisHold, closeQrisHoldTx, releasePosQris).
Masalah: `cancelPaymentLinkInTx` (payment.service.ts:1031) hanya menutup link LOKAL, tanpa panggilan ke penyedia. Pembayaran terlambat jadi refund.
Call site yang dicakup kartu: reservation-lifecycle.ts:532, facility-breakfast-money.ts:405, order-recovery-charge.ts:392, order-recovery-charge-staff.ts:161, order-recovery-charge-payment.ts:208, order-recovery-charge-pos.ts:261. (pos-order-payment.ts dan pos-qris-hold.ts = QRIS hold, JANGAN diubah selain ekstraksi helper bersama.)

## Aturan uang (founder Q93, "jangan sampai rugi")
- Sebelum batal lokal: cek/batalkan di penyedia (lewat port gateway; mock gateway di test).
- Penyedia sudah menerima uang: JANGAN batal lokal; terapkan pembayaran ke tagihan ATAU parkir SEKALI di dana tak teralokasi.
- Penyedia tak bisa dijangkau / jawaban tak pasti: tahan (fail-closed), jangan batal lokal, jangan refund.
- Tidak ada pihak dibayar lebih, tidak ada refund ganda, outlet tidak rugi. Idempoten.
- Migrasi hanya nomor 0459-0461. Jangan rahasia nyata.

## Bukti
Test gagal-dulu lalu hijau: `heavy env LEGEND_TEST_FILES="..." pnpm test` (dari root worktree). Satu pemegang heavy saja.

## Desain (keputusan engineer, 13 Nov)
Helper baru `apps/api/src/services/payment-provider-proof.ts`:
```ts
export type LinkProviderVerdict = "unpaid" | "settled";
export async function confirmLinkUnpaidAtProvider(
  context: ScopedTenantContext,
  linkId: string,
  now: Date,
): Promise<LinkProviderVerdict>;
```
- Jalan DI LUAR transaksi dan lock bisnis (I/O jaringan). Caller memanggilnya sebelum `withTenant` yang membatalkan, memakai linkId yang dibaca lebih dulu.
- Ambil intent link yang `pending` dan `providerRef` tidak null (intent tanpa providerRef = belum ke penyedia, lokal saja).
- Per intent: `paymentGatewayFor(intent.provider).getStatus({context,outletId,integrationId: intent.gatewayIntegrationId,providerRef,intentId})`.
  - `paid` dan providerRef sama: `settleGatewayIntentNow(context, intent.id, now)` (menerapkan pembayaran/parkir sekali, idempoten) -> verdict `settled`.
  - getStatus lempar error / providerRef beda: fail-closed, lempar `HttpError` 409 kode `PAYMENT_PROVIDER_UNCONFIRMED` (tidak ada batal lokal).
  - `pending`/`expired`/`failed`: tidak ada uang di penyedia -> panggil `gateway.cancel?.(...)` best effort (error ditelan), lanjut.
- Semua intent aman -> `unpaid`.
Caller:
- `unpaid`: lanjut alur batal lama (`cancelPaymentLinkInTx` tetap dipakai di dalam tx).
- `settled`: pembayaran sudah diterapkan; BACA ULANG status di tx. Charge/pesanan sudah paid: JANGAN batal lokal, pakai jalur "sudah dibayar" yang sudah ada di caller (reservasi DP paid -> kebijakan refund DP; sarapan paid -> refund; recovery charge tidak lagi open -> lewati). Tidak boleh refund ganda atau bayar lebih.
- 409 `PAYMENT_PROVIDER_UNCONFIRMED`: teruskan ke pemanggil API apa adanya (pesan lewat katalog teks bila perlu teks baru; cek AGENTS.md "Pra-gate").
