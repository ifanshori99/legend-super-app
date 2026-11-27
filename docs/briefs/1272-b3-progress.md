# B3 legend-wasr7.22 progres

Brief: `legend/docs/briefs/1272-b3-brief.md`. Cabang `ws/1272-b3` (dari int/rc2 b6629b9b5). Tanpa migrasi.

## Rencana

1. Kerangka `apps/edc-bridge-android/` (Gradle wrapper, AGP 9.5.3, minSdk 26, targetSdk 35, Room 2.8.5 + KSP) sampai `assembleDebug` hijau. `.gitignore` build/ dan local.properties.
2. Inti Kotlin tanpa Android (`protocol/`, `core/`, `link/`): parser ketat kontrak v1, dedupe sale (hash SHA-256 frame), lease `ttlMs` dari jam monotonik, antrean unacked terpisah dari catatan sale, aturan hapus, framing STX/BCD/ETX/LRC + ACK/NAK. Unit test JVM.
3. Lapisan Android: Room (`data/`), token di Keystore AES-GCM (`secure/`), foreground service + WSS OkHttp (`service/`), layar setelan (`ui/`).
4. Emulator jembatan Node: B2 sudah punya `apps/api/src/test/helpers/edc-bridge-emulator.ts` (tipis, tanpa jurnal; komentarnya: "the full emulator is B3"). B3 menambah emulator lengkap di file baru `apps/api/src/test/helpers/edc-bridge-tablet.ts` (jurnal, dedupe, lease, framing TCP) supaya tidak bentrok dengan file B2, plus generator fixture kontrak dari zod untuk test Kotlin.
5. `docs/design/edc-bridge-android.md`.

## Status

- Langkah 1 selesai: kerangka Gradle, `assembleDebug` + `testDebugUnitTest` hijau (AGP 9.5.3, Kotlin 2.4.21 dipin, OkHttp 4.12 karena 5.x butuh compileSdk 37).
- Langkah 2-5 selesai: inti Kotlin, Room (skema `app/schemas/.../1.json`), Keystore, foreground service + WSS OkHttp, layar setelan, emulator Node lengkap + fixture kontrak, `docs/design/edc-bridge-android.md`.
- Bukti: `heavy ./gradlew testDebugUnitTest assembleDebug` hijau, 37 test JVM (BridgeCore 17, Dispatcher 4, Clock/Pairing 4, FramedExchange 6, ContractFixtures 6: semua 90+ kasus downlink sama dengan zod). `LEGEND_TEST_FILES="src/test/edc-bridge-tablet.test.ts" heavy pnpm test` 13/13. eslint + prettier hijau.
- Belum diverifikasi: Room DAO/service di perangkat (tanpa emulator Android), USB-serial (lihat pertanyaan 2), uji lapangan B7.

- Review B3 LULUS 6 P3 (`legend/docs/qa/1272-b3-review.md`), semua dibetulkan: (1) `finishSale` hanya untuk catatan `in_flight`, balasan tidak menimpa hasil antre (test gagal-dulu: 5 gagal sebelum fix); (2) `TerminalRunner.shutdown` menutup link EDC dan menunggu sebelum DB ditutup (`TerminalRunnerTest`); (3) simpan setelan = `ACTION_RELOAD`, sesi WSS dibuka ulang; (4) baris jurnal rusak dilewati + dihitung; (5) tanpa Gradle Plugin Portal, `distributionSha256Sum` resmi; (6) emulator Node umur = min dua jam + penyelesaian terlambat dibuang (2 test gagal-dulu). Catatan void/cancel tanpa jurnal di dokumen. Bukti: 44 test JVM + `assembleDebug` hijau, emulator Node 15/15.

## Pertanyaan untuk CTO

1. Umur catatan sale (P3): brief menulis `max(monotonik+boot, dinding)`, tetapi alasan di review ("jam dinding bisa dimajukan") hanya tertutup bila diambil yang LEBIH PENDEK. Dengan max, jam dinding dimajukan 30 hari = semua catatan dedupe langsung terhapus. Diterapkan: `min` (hapus hanya bila kedua jam setuju; catatan disimpan lebih lama, aturan "jangan sampai rugi"). Satu fungsi `SaleRecordRetention.ageMs`, mudah dibalik bila CTO memutuskan lain.
2. usb-serial-for-android hanya ada di JitPack (bukan google()/mavenCentral(), yang diizinkan). USB belum disambung (`LinkConnectors.usb = null` -> `refused link_down`). Pilihan: izinkan JitPack, vendor sumber MIT ke repo, atau tulis driver CDC-ACM sendiri.
3. Kode pasang 8 karakter belum ada di B2; tablet saat ini menerima token `edcb_...` yang ditempel dari backoffice.
