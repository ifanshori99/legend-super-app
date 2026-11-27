# B3 legend-wasr7.22 progres

Brief: `legend/docs/briefs/1272-b3-brief.md`. Cabang `ws/1272-b3` (dari int/rc2 b6629b9b5). Tanpa migrasi.

## Rencana
1. Kerangka `apps/edc-bridge-android/` (Gradle wrapper, AGP 9.5.3, minSdk 26, targetSdk 35, Room 2.8.5 + KSP) sampai `assembleDebug` hijau. `.gitignore` build/ dan local.properties.
2. Inti Kotlin tanpa Android (`protocol/`, `core/`, `link/`): parser ketat kontrak v1, dedupe sale (hash SHA-256 frame), lease `ttlMs` dari jam monotonik, antrean unacked terpisah dari catatan sale, aturan hapus, framing STX/BCD/ETX/LRC + ACK/NAK. Unit test JVM.
3. Lapisan Android: Room (`data/`), token di Keystore AES-GCM (`secure/`), foreground service + WSS OkHttp (`service/`), layar setelan (`ui/`).
4. Emulator jembatan Node: B2 sudah punya `apps/api/src/test/helpers/edc-bridge-emulator.ts` (tipis, tanpa jurnal; komentarnya: "the full emulator is B3"). B3 menambah emulator lengkap di file baru `apps/api/src/test/helpers/edc-bridge-tablet.ts` (jurnal, dedupe, lease, framing TCP) supaya tidak bentrok dengan file B2, plus generator fixture kontrak dari zod untuk test Kotlin.
5. `docs/design/edc-bridge-android.md`.

## Status
- (mulai) 27 Nov.

## Pertanyaan untuk CTO
