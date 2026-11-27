# Aplikasi Android "Legend EDC Bridge" (B3, legend-wasr7.22)

Dasar: `docs/design/edc-auto-cloud.md` (aturan aman 1-7), `docs/design/edc-bridge-protocol.md`, kontrak `packages/shared/src/edc/bridge.ts`. Kode: `apps/edc-bridge-android/`. Jembatan = pipa: tidak ada aturan uang atau nominal di aplikasi.

## Isi

| Bagian   | File                                                                                             | Isi                                                                                                                                                                                                                                                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kontrak  | `protocol/Messages.kt`, `protocol/BridgeJson.kt`                                                 | Parser ketat (seperti `strictObject` zod): field asing/hilang, tipe salah, di luar batas = socket ditutup 1008. Maks 16 KB sebelum parse. UUID dikecilkan seperti `uuidSchema`. LAN hanya IPv4 privat RFC 1918.                                                                                                                             |
| Aturan   | `core/BridgeCore.kt`, `core/SaleDedupe.kt`, `core/SaleRecordRetention.kt`, `core/BridgeClock.kt` | Lease `ttlMs` dihitung dari saat diterima (jam monotonik). Dedupe hanya `sale` per terminal + trace dengan SHA-256 frame: sama + selesai = putar ulang (`replayOf`), sama + berjalan = `duplicate_in_flight`, frame beda = `trace_conflict`. Satu perintah per terminal (`terminal_busy`). Link ke alamat tablet sendiri = `lease_invalid`. |
| Sesi     | `core/BridgeDispatcher.kt`, `service/WssConnection.kt`                                           | `hello` dulu; sesudah `lease` pertama tiap sesi semua hasil belum di-ack dikirim ulang. Token hanya di header `Authorization` upgrade WSS. Sambung ulang 1 s sampai 60 s (+ acak). `goodbye token_revoked`/`protocol_unsupported` = berhenti; `replaced_by_newer_session` = tunggu 5 menit.                                                 |
| Terminal | `link/EcrFraming.kt`, `link/FramedExchange.kt`, `link/TerminalRunner.kt`                         | STX, panjang BCD 2 byte, isi, ETX, LRC (XOR panjang..ETX). ACK/NAK lokal, maks 3 kirim ulang. Tidak bisa membuka link = `refused link_down` (tidak ada yang terkirim). Selain jawaban bersih = `transport_error` (cloud `unknown` -> inquiry).                                                                                              |
| Jurnal   | `data/JournalDatabase.kt`, `data/RoomJournalStore.kt`                                            | Room: `unacked_results` (dihapus oleh `ack`) terpisah dari `sale_records` (tidak disentuh `ack`). Catatan sale ditulis `in_flight` sebelum terminal disentuh; hasil + status `done` dalam satu transaksi.                                                                                                                                   |
| Rahasia  | `secure/DeviceSettings.kt`                                                                       | Token `edcb_...` dienkripsi AES-GCM dengan kunci Android Keystore; hanya ciphertext di SharedPreferences. Tidak pernah di log, tidak tampil lagi. Backup dan transfer perangkat dimatikan.                                                                                                                                                  |
| Layanan  | `service/BridgeService.kt`, `service/BootReceiver.kt`, `ui/SetupActivity.kt`                     | Foreground service tipe `connectedDevice`, mulai sendiri sesudah boot bila sudah dipasangkan.                                                                                                                                                                                                                                               |

### Umur catatan sale (review B1 P3)

Catatan menyimpan jam dinding dan jam monotonik tahan-reboot (`PersistentMonotonicClock`: checkpoint terakhir + `elapsedRealtime`; sesudah reboot hanya uptime boot baru yang ditambah, jadi tidak pernah lebih cepat dari waktu nyata). Umur = yang LEBIH PENDEK dari keduanya: catatan dihapus (48 jam DAN `sale_record_release`, atau 30 hari) hanya bila kedua jam setuju. Jam dinding yang dimajukan tidak bisa menghapus catatan dedupe lebih awal. Menunggu konfirmasi CTO (brief menulis `max`; lihat `docs/briefs/1272-b3-progress.md`).

Sesudah restart, sale yang masih `in_flight` menjadi `transport_error disconnected` dan masuk antrean: cloud mencatat `unknown` lalu inquiry; sale ulang dengan trace dan frame sama memutar ulang jawaban itu, tidak pernah dijalankan lagi.

Jawaban pertama dijaga di database: `JournalDao.finishSale` hanya mengubah catatan yang masih `in_flight` (`... AND state = 'in_flight'`); penyelesaian terlambat sesudah restart dibuang. Antrean unacked: balasan (penolakan, replay) tidak pernah menimpa hasil yang sudah antre untuk `commandId` sama (`INSERT OR IGNORE`); hasil dari terminal menimpa balasan (`REPLACE`). Baris jurnal yang tidak terbaca dilewati saat kirim ulang dan dihitung (`RoomJournalStore.undecodableResults`), sisanya tetap terkirim.

Void, cancel, dan inquiry tidak dijurnal sebelum jalan (hanya sale yang punya catatan). Aplikasi mati di tengah perintah itu = tidak ada result; cloud B2 menunggu tenggat lalu mencatat `unknown` dan inquiry (keputusan CTO 27 Nov, review B3).

Berhenti/ganti setelan: `onDestroy` menghentikan WSS, menutup semua koneksi TCP ke EDC (`TerminalRunner.shutdown`), menunggu maks 5 s sampai perintah berjalan menjurnal hasilnya, baru menutup database; jadi instance baru tidak pernah membuka koneksi kedua ke EDC yang sama (test JVM `TerminalRunnerTest`). "Simpan dan jalankan" mengirim `ACTION_RELOAD`: sesi WSS dibuka ulang dengan alamat/token baru (juga sesudah token dicabut), jurnal dan perintah berjalan tetap.

## Build

Butuh JDK 17 dan Android SDK (platform 35, build-tools 35.0.0). Di Mac tim:

```sh
cd apps/edc-bridge-android
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export ANDROID_SDK_ROOT=/opt/homebrew/share/android-commandlinetools
echo "sdk.dir=$ANDROID_SDK_ROOT" > local.properties   # tidak di-commit
heavy ./gradlew testDebugUnitTest   # unit test JVM
heavy ./gradlew assembleDebug       # app/build/outputs/apk/debug/app-debug.apk
```

Repositori hanya `google()` dan `mavenCentral()` (juga untuk plugin: AGP, KSP, Room ada di sana; tanpa Gradle Plugin Portal). Wrapper memeriksa `distributionSha256Sum` dari checksum resmi Gradle.

Versi: Gradle wrapper 9.9.2, AGP 9.5.3 (Kotlin bawaan, compiler dipin 2.4.21), Room 2.8.5 + KSP 2.3.14, OkHttp 4.12.0 (5.x butuh compileSdk 37), kotlinx-serialization-json 1.13.0 (hanya runtime, tanpa plugin). minSdk 26, targetSdk 35. Hanya repositori `google()` dan `mavenCentral()`.

Fixture kontrak `app/src/test/resources/edc-bridge-contract-fixtures.json` dibuat dari zod: ubah kontrak shared, lalu `UPDATE_EDC_BRIDGE_FIXTURES=1 LEGEND_TEST_FILES="src/test/edc-bridge-tablet.test.ts" heavy pnpm test` dan jalankan ulang test JVM. Test TS gagal bila file usang.

APK rilis: belum ada kunci tanda tangan. Kunci rilis disimpan di luar repo (keputusan founder sebelum B7); APK debug hanya untuk uji.

## Emulator Node

`apps/api/src/test/helpers/edc-bridge-tablet.ts` (`EdcBridgeTablet`): aturan yang sama dengan aplikasi (lease, dedupe, jurnal, kirim ulang, release/purge, restart), terminal berupa skrip atau TCP sungguhan dengan framing yang sama (`tcpTerminal`, `startFakeEcrTerminal`). Untuk B6 e2e. Test: `apps/api/src/test/edc-bridge-tablet.test.ts`. Emulator tipis B2 (`edc-bridge-emulator.ts`) tetap untuk test B2.

## Pasang ke tablet (sideload)

1. Di tablet: Setelan > Tentang tablet > ketuk "Nomor build" 7 kali (opsi pengembang), lalu nyalakan "Debugging USB". Atau izinkan "Instal aplikasi tak dikenal" untuk aplikasi file/browser bila APK disalin.
2. Lewat kabel: `adb install -r app/build/outputs/apk/debug/app-debug.apk` (platform-tools di `$ANDROID_SDK_ROOT/platform-tools`). `-r` memperbarui tanpa menghapus jurnal.
3. Jangan copot pasang aplikasi saat masih ada hasil belum di-ack (jurnal ikut hilang). Cek angka `unackedResults` di cloud dulu.

## Izin Android

- Notifikasi (Android 13+): diminta saat layar setelan dibuka; notifikasi tetap adalah syarat foreground service.
- Foreground service `connectedDevice` + `CHANGE_NETWORK_STATE` (syarat Android 14+), `INTERNET`, `ACCESS_NETWORK_STATE`, `RECEIVE_BOOT_COMPLETED`. Semua izin normal kecuali notifikasi.
- Baterai: Setelan > Aplikasi > Legend EDC Bridge > Baterai > "Tidak dibatasi", supaya layanan tidak dimatikan saat layar mati. Pada merek dengan penghemat agresif (Xiaomi, Oppo, Vivo) juga nyalakan "Mulai otomatis".
- USB (nanti): izin per perangkat USB diminta sistem saat EDC dicolok. Driver serial belum disambung, lihat "Belum".

## Pasangkan

1. Backoffice: buat perangkat jembatan di outlet (B2 `/api/edc-bridge/devices`, izin `payment.edc.manage`), salin token (tampil sekali), tugaskan terminal EDC ke perangkat itu.
2. Tablet: buka Legend EDC Bridge, isi alamat server (`https://host`, tanpa path) dan token, "Simpan dan jalankan". Status "Terhubung ke server." di layar dan notifikasi.
3. Ganti tablet = buat token baru; cabut token lama di backoffice.

## Uji lapangan B7 (qa + founder, terminal asli)

1. EDC dan tablet di Wi-Fi/LAN yang sama, EDC dengan IP tetap privat (mis. 192.168.1.50) dan mode ECR menyala. Port ECR sesuai dokumen bank.
2. Sale kecil (Rp 1.000) dari kasir: EDC menampilkan nominal, kartu diproses, kasir menerima "approved"; struk dan riwayat cocok.
3. Matikan Wi-Fi tablet tepat sesudah kartu ditempel: transaksi di kasir `unknown`, lalu nyalakan lagi; hasil terkirim ulang dan transaksi selesai lewat inquiry tanpa tagihan ganda.
4. Paksa berhenti aplikasi saat menunggu kartu: sesudah dibuka lagi, cloud mendapat `transport_error`, kasir melihat "cek di mesin"; tidak ada sale kedua di EDC.
5. Cabut kabel LAN EDC: perintah berikut `link_down`, kasir mendapat jalan keluar manual (X1).
6. Dua tablet dengan terminal sama: hanya satu yang mendapat lease (`held_by_other_device`).
7. Void dan settlement: void sampai ke EDC; sesudah impor settlement, `heldSaleRecords` di `hello` turun.
8. Hentikan jembatan dari layar setelan saat EDC menunggu kartu, lalu jalankan lagi: EDC tidak menerima sale kedua, kasir mendapat `unknown`/"cek di mesin", hasil terkirim sesudah tersambung lagi (lifecycle service hanya diuji JVM, bukan di perangkat).
9. Ganti token di layar setelan saat terhubung: sesi tersambung ulang dengan token baru tanpa menghentikan aplikasi.
10. Catat merek/model EDC, versi Android tablet, waktu respons, dan semua kejadian NAK/timeout.

## Belum

- USB-serial: `usb-serial-for-android` hanya ada di JitPack, di luar repositori yang diizinkan. `LinkConnectors.usb` kosong, jadi lease USB menjawab `refused link_down`. Menunggu keputusan CTO (izinkan JitPack, vendor sumber MIT, atau driver CDC-ACM sendiri).
- Kode pasang 8 karakter (B2 belum membangun); tablet memakai token tempel.
- Room DAO dan service belum diuji di perangkat atau test instrumentasi (tanpa emulator Android); logika di atasnya diuji JVM lewat `InMemoryJournalStore`.
- Framing per bank (B5) bisa menambah nilai `framing`.
