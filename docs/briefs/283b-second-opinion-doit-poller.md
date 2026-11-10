# Brief 283b: second opinion untuk lease poller DOIT (legend-rfiof)

## Peran

Baca `~/.agents/team/roles/second-opinion.md` dan `~/.agents/team/TEAM.md`.

- Agent Codex, model `gpt-6.1-sol`, effort xhigh (tingkat K: uang).
- Read-only: jangan ubah kode, jangan commit, jangan push, jangan merge.
- Jangan baca `.env*` atau isi rahasia apa pun.
- Langkah pertama: pecah tugas, lalu spawn subagent paralel dalam satu giliran (jika dibutuhkan).

## Repo

- Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/doit-pending-poller`, cabang `ws/doit-pending-poller`.
- Diff review: `git diff milestone/m1...ws/doit-pending-poller`.
- Isi diff: kolom `payment_intents.gateway_poll_lease_until` (migrasi `apps/api/drizzle/0190_poll_lease.sql`, journal idx 190), klaim atomik `FOR UPDATE SKIP LOCKED` dan pelepasan lease di `finally` pada `pollPendingGatewayIntents` (`apps/api/src/services/payment.service.ts`), dan dua file test baru: `apps/api/src/test/payment-poll-lease.test.ts`, `apps/api/src/test/payment-terminal-paid.test.ts`.
- Konteks keputusan: poller DOIT untuk intent pending SUDAH ada (legend-b9i). Resolver id DOIT dan pemanggil `createDoitPaymentReader` sengaja tidak dibangun (lihat bd comment legend-rfiof). `syncExpiredIntentPayment` (expired ke paid) sengaja tidak disentuh: menunggu keputusan founder.
- Berkas lain yang perlu dibaca: `apps/api/src/services/payment-lifecycle.ts` (`decidePaymentConfirmation`), `apps/api/src/services/payment-webhook.service.ts` (`findBoundIntent`, `processPaymentEvent`), `packages/shared/src/payment/index.ts` (tabel transisi status).

## Pertanyaan review

1. Dua worker (atau dua pemanggil) bersamaan: adakah celah di antara klaim (`select ... for update skip locked` lalu `update` lease dalam satu transaksi) dan pemrosesan, sehingga intent yang sama ditanyakan ke DOIT dua kali? Perhatikan lease dibandingkan dengan parameter `now` pemanggil, bukan jam database.
2. Pelepasan lease di `finally`: bila proses mati di tengah putaran, lease berakhir sendiri setelah `GATEWAY_POLL_LEASE_MS` (2 menit). Apakah ada jalur di mana intent terjebak tak terpoll lebih lama dari itu, atau lease dilepas padahal pemrosesan masih berjalan (misal anggaran waktu 20 detik terlewati dalam satu panggilan gateway)?
3. Apakah perubahan ini mengubah perilaku poller lama: urutan least-recently-polled, `limit`, backoff, stempel `gateway_polled_at`, hitungan `checked`/`settled`? `syncExpiredIntentPayment` tidak boleh berubah.
4. Status akhir: poller hanya memilih `pending` dan `expired` ber-`providerRef`. Status `failed`, `refunded`, `partially_refunded` tidak pernah dipilih. Webhook `paid` untuk `failed` hari ini menyelesaikan sebagai late payment (test `payment-webhook-api.test.ts` ~1002; keputusan founder menunggu); untuk `refunded`/`partially_refunded` dengan id DOIT sama adalah `duplicate` (tidak ada catatan baru), dengan id berbeda ditolak `REFERENCE_MISMATCH`. Benarkah klaim ini? Adakah jalur uang masuk yang tidak tercatat?
5. Migrasi 0190: ALTER TABLE ADD COLUMN nullable, tanpa backfill, `when` 1794269000000. Aman untuk rantai migrasi (idx 186 lalu 190)? Snapshot `0190_snapshot.json` konsisten dengan skema?
6. Apakah test benar-benar membuktikan klaimnya (dua worker bersamaan, lease dilepas, lease lewat waktu diambil lagi), dan adakah yang rapuh (bergantung waktu, urutan, data bersama antar file test)? Catatan: `payment-poll-lease.test.ts` memarkir intent lain di tenant dengan lease jauh di masa depan lalu memulihkannya.

## Keluaran

Temuan nyata saja, diurutkan menurut keparahan, tiap temuan: file:baris, skenario gagal konkret, usulan perbaikan. Tulis "tidak ada temuan" untuk pertanyaan yang bersih. Tandai apa yang tidak terverifikasi.
