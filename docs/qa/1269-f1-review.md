# 1269 F1 review K (48b30294b): LULUS BERSYARAT (hanya `test.echo` aktif)

Path relatif `apps/api/src`. Keputusan CTO: no. 1-3 + P3 + test usang dibetulkan SEBELUM digabung.

1. **P2** `edge/cloud-command-client.ts:117`: settle commit sendiri dan membuka kunci tagihan; crash sebelum hasil diterapkan = potong dua kali. Hook per kind `onSettled(tx,row)` di transaksi settle, hanya saat baris benar-benar berpindah; test crash.
2. **P2** `services/edge-cloud-command.service.ts:103`: `FOR SHARE` selama handler berisiko deadlock dengan `UPDATE edge_nodes` (`edge/db-link-store.ts:875`). Pakai `.for("key share")`; revoke `FOR UPDATE` tetap menunggu; test dua arah.
3. **P2** `:249,:288`: lokal `lock_timeout` 5 dtk dan `statement_timeout` 10 dtk; hasil 503, edge tetap `unknown`.
4. **P3** batasi ukuran `result`; `RESOLVE_BATCH` berhenti saat NETWORK dan rotasi; test lewat `createApp`; retensi body/result (data pribadi); alarm edge tertinggal jam > TTL.
5. **Test usang E2** `edge/cloud-http.test.ts:508`: hapus `deviceTokenHashes` dari `first`, assert retry tak membawanya (legend-jcby0).

Keputusan: kirim ulang byte sama hanya saat belum kedaluwarsa, pemulihan/boot hanya status. Umur minimum `resolveOpen` 30 dtk sejak kirim/dibuat + daftar in-flight; dipasang sebelum E9 aktif.

Dibawa kartu lain: F11b: status/nisan bagi primary aktif outlet sama bila pemilik baris `revoked` (eksekusi tidak), term, daftar eksekusi per outlet. E9: handler hanya mencatat niat, provider di luar transaksi, `succeeded` bukan lunas. F3/E9: unik per order+manfaat di cloud. F11b boleh mulai; E9 sesudah no. 1-3; F3 sesudah no. 1-3, F2, E9.
