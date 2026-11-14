# legend-baz8i: hold QRIS nominal salah (Duitku strict)
Repo: worktree legend-2cecbfb6, cabang fix/qris-hold-strict-amount. Tanpa migrasi. Jangan commit/pkill/panggil Duitku.

## Temuan
- `apps/api/src/services/payment.service.ts`: `assertStrictAmount` (~:1414) -> `holdGatewayAmountMismatch` (~:1289). Fungsi itu sudah: gagalkan intent, audit `payment.amount_mismatch_held`, parkir uang sekali lewat `recordUnsettledGatewayFundsInTx` (evidence unique tenant+provider+providerRef; return false = replay). Dipanggil juga oleh `payment-duitku-webhook.service.ts:385`.
- KEKURANGAN: tidak menyentuh `posQrisHolds` dan tidak mengirim alert. Jalur `parkWhenQrisHoldRefusesInTx` (~:1700) sudah: cari hold intent, bila parkir baru (inserted) -> set `nextCheckAt` +24 jam (hold tetap open/cancelling) dan `notifyOutletSupervisors` event `payment_qris_funds.parked` (alsoOwners, alsoUserIds [hold.openedBy]).
- Hold TIDAK boleh ditutup otomatis (Q93: manajer buka kunci via `releasePosQris`, pos-qris-hold.ts:742).

## Perubahan yang diminta (implementer, hanya payment.service.ts)
1. Ekstrak helper in-tx `alertQrisFundsParked(tx, context, intent, hold{id,openedBy}, paidAmountIdr, now)` dari blok setelah `inserted` di `parkWhenQrisHoldRefusesInTx` (update nextCheckAt + notifyOutletSupervisors), pakai ulang di sana (perilaku identik).
2. Di `holdGatewayAmountMismatch`: tangkap return `recordUnsettledGatewayFundsInTx`. Bila true: cari `posQrisHolds` untuk intent; bila ada dan state != 'paid', panggil helper. Hold tidak diubah state-nya. Replay (false) = tanpa alert, tanpa parkir ganda. Body notifikasi sebut kasir/manajer: QR dibayar nominal salah, uang diparkir, minta manajer.
3. Perbarui komentar doc yang usang. Jangan ubah import tak perlu.

## Test gagal-dulu (test-writer, file baru apps/api/src/test/pos-qris-hold-strict-amount.test.ts)
Pakai `pos-qris-hold-test-helpers.ts` (holdFixture, issueQris, readHold, assertInvariants) dan pola `pos-qris-hold-poll-wrong-amount.test.ts`. Kasus: (a) QR Rp33.000 duitku dibayar nominal lain lewat jalur strict (`assertStrictAmount`/poll) -> seluruh nominal diparkir tepat sekali di paymentUnallocatedFunds, tagihan tidak tertutup, hold tetap open, notifikasi `payment_qris_funds.parked` tercatat ke kasir pembuka; (b) notifikasi/poll sama dua kali -> 1 dana, 1 notifikasi; (c) uang tidak dibukukan sebagai payment (tidak ada pihak dibayar lebih). Jalankan: `LEGEND_TEST_FILES="src/test/pos-qris-hold-strict-amount.test.ts" heavy pnpm test` (dari root worktree). Harus GAGAL dulu karena alert hilang (bukan karena setup).
