# Brief 117: second opinion untuk refund DOIT (legend-0ogy)

## Peran

Baca `~/.agents/team/roles/second-opinion.md` dan `~/.agents/team/TEAM.md`.

- Read-only: jangan ubah kode, jangan commit.
- Langkah pertama: pecah tugas, lalu spawn subagent paralel dalam satu giliran.
- Dua run terpisah (A dan B), satu akun Codex per run. Tiap run hanya membaca diff miliknya; berkas lain boleh dibuka untuk konteks.

## Repo

- Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/doit-refund`, cabang `ws/doit-refund`, HEAD `5316426a`.
- Basis diff `176c8912` (merge `milestone/m1` ke cabang ini). Diff di bawah hanya berisi pekerjaan refund DOIT, tanpa isi merge m1.
- Konteks fitur: PRD `docs/PRD.md` baris 706 (PAY-04) dan 708 (PAY-06); kontrak `docs/plan/contracts.md` baris 118 sampai 119; kontrak port di kepala berkas `apps/api/src/services/payment-refund-gateway.ts`; dokumentasi DOIT https://doit.id/docs/en/#refund dan `#errors`.

## Run A: adapter, port, payout, kill switch (708 baris diff)

Perintah:

```
git diff 176c8912 5316426a -- .env.example apps/api/src/config/env.ts apps/api/src/server.ts apps/api/src/worker-main.ts apps/api/src/services/payment-doit-wire.ts apps/api/src/services/payment-doit.ts apps/api/src/services/payment-refund-gateway.ts apps/api/src/services/payment-refund.service.ts
```

Berkas berisiko:

- `apps/api/src/services/payment-doit.ts`: `refund()` dan `getRefundStatus()` di `createDoitGateway`, serta perluasan `call()` (pembacaan kode error, gabungan `AbortSignal`).
- `apps/api/src/services/payment-doit-wire.ts`: `parseDoitRefundAnswer`, `doitRefundDeclineCode`, `parseDoitErrorCode`, `DoitRefundUnknownError`.
- `apps/api/src/services/payment-refund.service.ts`: `runRefundPayout` (claim, lookup, send, pencatatan hasil), `retryRefundPayout`, `sweepApprovedRefundPayouts`, `decideRefund` setelah approve.
- `apps/api/src/server.ts`, `apps/api/src/worker-main.ts`, `apps/api/src/config/env.ts`: pemasangan port refund dan `DOIT_REFUNDS_ENABLED`.

Test terkait (boleh dibaca dan dijalankan): `src/test/payment-doit-refund.test.ts`, `src/test/payment-doit-refund-fund.test.ts`, `src/test/payment-refund-codex-fix.test.ts`, `src/test/payment-refund-approval.test.ts`.

## Run B: webhook refund DOIT (748 baris diff)

Perintah:

```
git diff 176c8912 5316426a -- apps/api/src/services/payment-doit-refund-webhook.ts apps/api/src/services/payment-webhook.service.ts
```

Berkas berisiko:

- `apps/api/src/services/payment-webhook.service.ts`: gerbang jenis event di `receiveDoitWebhook`, dispatcher `processStoredEvent`, `processRefundEvent`, `findRefundTarget`, pencocokan objek payment ke refund, audit ketidakcocokan integrasi, dan jalur retry worker `reprocessStoredWebhookEvents`.
- `apps/api/src/services/payment-doit-refund-webhook.ts`: parser `data` webhook `refund.*`, `matchDoitRefundEvent`, `pickRefundCandidate`.
- Titik masuk bersama: `applyRefundProviderUpdate` di `apps/api/src/services/payment-refund.service.ts` (tidak diubah di diff ini, tapi menjadi tujuan webhook).

Test terkait: `src/test/payment-doit-refund-webhook.test.ts`, `src/test/payment-webhook-api.test.ts`, `src/test/payment-webhook-retry-integration.test.ts`.

## Invariant uang (tingkat K, berlaku untuk kedua run)

1. Refund tidak boleh dibayar dua kali. Satu refund menghasilkan paling banyak satu transaksi refund di DOIT, termasuk setelah timeout, error 5xx, restart worker, lease kedaluwarsa, retry ops, dan dua worker bersamaan.
2. Idempotensi: tiap kiriman ke DOIT memakai `Idempotency-Key: refund:<refundId>`. Pengulangan permintaan yang sama tidak boleh punya efek samping kedua (kontrak baris 118). Kunci yang sama dengan permintaan berbeda tidak boleh membuat transaksi baru.
3. Refund hanya untuk pembayaran `paid` dan tidak boleh melebihi jumlah yang dibayar (kontrak baris 119). Jumlah yang dikirim harus sama dengan jumlah refund yang disetujui.
4. Status akhir hanya dari bukti: refund ditandai `completed` hanya bila uang terbukti keluar, dan `failed` hanya bila uang terbukti tidak keluar. Jawaban provider yang tidak dikenali, timeout, atau error sementara tidak boleh menjadi `completed` atau `failed`.
5. Webhook refund hanya diterima dari integrasi pembuat tagihan: tanda tangan harus valid, dan integrasi yang memverifikasi harus integrasi yang membuat payment intent milik refund itu. Event dari integrasi lain tidak boleh mengubah refund mana pun.
6. Webhook atau poll tidak boleh menutup refund yang salah: satu event hanya menyelesaikan satu refund yang benar-benar dimaksud, termasuk untuk refund dana tak teralokasi (PAY-04: pembayaran ganda atau lebih bayar), yang sumber uangnya bukan pembayaran utama intent.
7. Kill switch: dengan `DOIT_REFUNDS_ENABLED` mati (default), tidak ada uang keluar lewat DOIT dan tidak ada state refund yang berubah sehingga refund tidak bisa dikirim normal setelah switch dinyalakan. Dengan switch menyala, API dan worker berperilaku konsisten.
8. Karantina: refund berstatus karantina (`PAYOUT_QUARANTINED`) tidak pernah dikirim ke provider, tetapi hasil provider untuk refund itu tetap dicatat.
9. PAY-06: kredensial, body respons, header, dan secret webhook tidak pernah masuk log, error, atau respons API.

## Laporan

Satu laporan per run. Temuan diurutkan dari yang paling berat. Tiap temuan: file:baris, invariant yang dilanggar, skenario gagal konkret (urutan kejadian dan data), fix. Tulis "Tidak ada blocker" bila memang tidak ada. Boleh reproduksi dengan DB sementara lewat `LEGEND_TEST_FILES="<file>" pnpm test` dari root worktree; bersihkan sesudahnya.
