# 488 Second opinion Codex: langganan berulang + tenggang + outbox + blind-index (area)

Peran: second-opinion (`~/.agents/team/roles/second-opinion.md`). Read-only. Jangan edit, jangan commit. Effort xhigh (uang + migrasi + data pribadi).

Repo: `/Users/ifanshori99/Projects/legend super app/legend`. Baca AGENTS.md.

Cakupan (gabungan cabang, satu review per area):
- `git diff origin/milestone/m1...origin/ws/fac07-outbox-events` (berisi ws/6c6-recurring-billing 7298123f + fac07 e50526f7, 9992e1d3, f64e958f, 6d9d766e).
- Fokus uang: tenggang langganan (`subscriptionHasAccess`, `subscriptionAccessPeriod`, `syncSubscriptionQuota`), batas kuota `min(quota, graceDays x maxPerDay)`, harga plan fasilitas vs DOIT, bayar telat, pindah plan saat tenggang, tagihan berulang ganda/terlewat, idempotensi worker. Tidak boleh ada pihak dapat kuota/akses lebih dari yang dibayar.
- Outbox: `session.revoked`, `tenant.status_changed`, `tenant.package_changed` satu transaksi dengan perubahan; konsumen `identity`; urutan dan duplikasi.
- Blind-index v2 (HKDF) legend-n039: v1 tetap sama, rebuild/verify, rollback `BLIND_INDEX_ACTIVE_VERSION`, rolling deploy pod lama menulis v1.
- Migrasi 0290 (6c6) dan 0300 (tulis tangan): aman untuk data ada, journal `when` unik naik.

Sudah diketahui (jangan dilaporkan ulang): legend-baxdx (dua pemakai blindIndex lama), legend-5zb6g (restoreTenant tanpa event), legend-6qu47 (sweep kuota satu transaksi), undangan admin pertama ke email belum terverifikasi (sedang diperbaiki), break-glass boleh skip gap (disengaja, teraudit).

Laporan: temuan P0..P3, masing-masing file:line, skenario gagal konkret, usul perbaikan. Maks 12 temuan, urut keparahan. Tidak ada temuan: tulis "bersih" plus apa saja yang dicek.
