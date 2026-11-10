# Hasil Codex 158: second opinion klasifikasi event edge

- Tanggal: 9 November 2026.
- Cabang diperiksa: `ws/edge-event-class`.
- Worktree: `.worktrees/edge-event-class`.
- Rentang: `21edd29b..2216e2b7`; HEAD saat verifikasi `2216e2b7b27c55c800a7c78d965f939faee7af9f`.
- Scope: klasifikasi akses, deferred inbox, transaksi penerimaan, alarm unclassified, dan test terkait. Kode produksi tidak diubah; tidak ada commit, push, atau merge.

## Temuan

Tidak ada temuan bug baru dengan skenario gagal konkret pada diff ini.

## Bukti pemeriksaan

- Registrasi `pos_override` dan `staff_pin` mempertahankan kind `transaction_event`, sama dengan fallback basis. Perubahan alasan parkir tidak mengubah semantik sequence.
- Scope tenant/outlet/node tetap diperiksa sebelum parkir; envelope disimpan utuh. Tidak ditemukan pembaca production yang bergantung pada `parked_reason='unclassified'` untuk event akses.
- Alarm hanya dipanggil setelah insert baris parkir baru. Redelivery yang sudah tercatat di `edge_received_events` dilewati sebelum applier; jalur konflik insert parkir juga melewati alarm.
- Savepoint alarm berada di dalam savepoint applier; kegagalan alarm di-rollback tanpa membatalkan parkir dan event berikutnya. Dedupe menggunakan alarm outbox yang berhasil dibuat, bukan aktivitas baris parkir; kegagalan savepoint atau ketiadaan penerima tidak menulis penanda dedupe.
- Filter dedupe mencakup tenant, outlet, aggregate type, nama event, dan 24 jam. Payload alarm hanya memuat `edgeNodeId`, `eventName`, dan `aggregateType`; id sumber alarm menggunakan ULID sendiri.
- Ekstraksi `notifyOutletSupervisors` mempertahankan isi serta pemilihan penerima alarm konflik lama. Penerima tetap dibatasi role aktif dalam tenant dan cakupan outlet, dengan fallback owner tenant.

## Verifikasi dijalankan

```sh
LEGEND_TEST_FILES='src/test/edge-event-class.test.ts src/test/edge-order-deferred.test.ts src/test/edge-sync-conflicts.test.ts' pnpm test
```

- Hasil: exit 0; 3 file lulus, 56 test lulus, pada HEAD di atas.
- Run memakai PostgreSQL test terisolasi; container dan network test berhasil dibersihkan.
- Mencakup R/A/B/C/D, regresi deferred order, serta regresi konflik dan penerima alarm. Log lokal: `/tmp/legend-158-second-opinion-tests.log`.
- `git diff --check 21edd29b..2216e2b7`: exit 0.
- Tiga subagent dimulai paralel sebelum perpindahan akun (puncak 3). Hasil klasifikasi/transaksi serta run awal 24 test diterima; pemeriksaan alarm dan run gabungan 56 test dituntaskan parent setelah perpindahan akun.

## Batas verifikasi dan risiko yang sudah diterima

- Test R tidak dijalankan ulang pada checkout basis bersih. Fallback `unclassified` di basis diperiksa lewat `git show`; hasil R pada HEAD tidak dipresentasikan sebagai reproduksi basis bersih.
- Dua batch serentak dengan event berbeda tetapi tuple dedupe sama masih dapat membuat dua alarm; ini diterima dalam brief. Tidak menjalankan uji konkurensi baru.
- Tidak menjalankan benchmark query dedupe pada outbox besar. Index khusus belum tersedia; penilaian performa produksi tetap memerlukan volume dan query plan nyata.
- Tidak menjalankan build, lint, typecheck, atau suite penuh dalam second opinion ini.
- Kategori alarm yang sama dengan `edge_sync_conflict` (legend-vw3d), proyeksi cloud akses dan replay deferred (legend-kyie) tetap di luar scope.
