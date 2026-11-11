# 488 Temuan second-opinion billing FAC-07 + keputusan CTO

Sumber: Codex G0i11, review diff s/d 6d9d766e. Semua dikerjakan di cabang `ws/fac07-outbox-events`. Tiap temuan: test gagal-dulu, lalu fix. Aturan uang: tidak ada pihak dapat kuota/akses/tagihan lebih dari yang benar.

P1
1. `payment-recurring.service.ts:484` dua start bersamaan (key beda) membuat dua langganan DOIT. Keputusan: unique partial index (customer, plan, status aktif/pending) + kunci per pelanggan+plan SEBELUM memanggil gateway. Test: dua start paralel -> satu langganan, satu ditolak.
2. `facility-subscription-quota.ts:185` dedup grant per fasilitas; pindah pemetaan A->B dalam periode sama memberi kuota ganda. Keputusan: dedup dan lock per (subscription, periode) lintas fasilitas, termasuk grant tenggang.
3. `facility-subscription-quota.ts:118` pause/cancel/tenggang diturunkan tidak mencabut grant tenggang. Keputusan: cabut grant tenggang yang belum terpakai secara atomik saat pause/cancel/tenggang turun; worker baca ulang status di bawah lock.
4. `platform-org.service.ts:504` event suspend/archive tidak terkirim karena relay hanya tenant aktif. Keputusan: event tenant lifecycle lewat jalur control-plane yang tidak difilter status tenant.
5. `identity-session.service.ts:314` sesi `tenantId` kosong (termasuk login staf biasa) dicabut tanpa event. Keputusan: isi `session.tenant_id` saat login staf; sesi platform murni emit event global. Uji lewat jalur login sebenarnya.
6. `env.ts:118` default blind-index v2 berbahaya saat rolling deploy. Keputusan: default `BLIND_INDEX_ACTIVE_VERSION=1`; v2 diaktifkan manual setelah semua pod baru (tulis langkahnya di `docs/deployment.md`).

P2
7. `facility-subscription-quota.ts:205` maxPerDay tidak membatasi pemakaian harian. Keputusan (membatasi): grant tenggang diterbitkan per hari (maxPerDay per hari, berlaku hari itu), bukan sekaligus.
8. `payment-recurring.service.ts:223` invoice periode berikut terbit saat periode sebelumnya belum lunas tertahan `needs_review` selamanya. Keputusan: parkir invoice berurutan, evaluasi ulang setelah periode sebelumnya lunas; tetap tidak memberi akses sebelum lunas.
9. `platform-org.service.ts:235` `tenant.package_changed` ke `cloud-sync` ditandai delivered oleh transport no-op. Keputusan: fail-closed (tidak delivered) bila tujuan tidak ada; sambungkan consumer nyata bila sudah ada.
10. `blind-index-rebuild.job.ts:221` verify melewati baris terkunci. Keputusan: hitung baris terlewat dan retry; verify bersih hanya bila terlewat = 0.
11. `docs/deployment.md:359` rollback dan fingerprint idempotensi v2. Keputusan: build berikut membaca kedua versi; dokumen rollback menyebutnya.
