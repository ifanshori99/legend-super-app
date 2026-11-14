# Edge KDS: status pemindai dilaporkan perangkat (legend-40nvj)

Status: usulan kontrak, 14 Nov 2026. Asal: legend-tzyj2 (WS-04).

## Masalah

Halaman KDS web tidak bisa mendeteksi pemindai keyboard-wedge. Web punya
`getKdsScannerStatus` lokal (`apps/web/src/features/ws04-kds/contract-gap.ts`,
`GET /api/outlets/:outletId/kitchen/scanner-status`, `{ data: { status } }`),
tetapi di luar mock endpoint itu belum ada, sehingga web menampilkan "unknown".
Yang bisa melihat pemindai hanya perangkat (device shell di tablet KDS atau edge
agent), jadi perangkat yang melapor.

## Keputusan desain

1. **Jalur lapor = heartbeat perangkat yang sudah ada**, bukan endpoint baru.
   `POST /api/devices/heartbeat` (cloud) dan jalur edge memakai skema yang sama
   (`packages/shared/src/edge/schemas.ts:83`, strictObject). Autentikasi tidak
   berubah: id perangkat tetap berasal dari `X-Device-Token` yang sudah
   diverifikasi; tidak ada pairing, token, atau izin baru.
2. **Payload**: tambah satu field opsional ke heartbeat:
   `scanner?: { status: "connected" | "disconnected"; observedAt: ISO datetime }`.
   Opsional supaya shell lama tetap valid. `observedAt` = saat shell terakhir
   melihat perubahan. Nilai di depan jam server tidak menolak heartbeat:
   server memotongnya ke `now` (seperti `LEAST(occurredAt, now)`), jadi jam
   perangkat yang melenceng tidak membuat `last_seen_at` berhenti maju dan
   perangkat tidak tampak offline.
3. **Frekuensi**: ikut siklus heartbeat yang ada (tidak ada timer baru). Shell
   juga mengirim satu heartbeat segera saat status pemindai berubah, supaya
   "terputus" tampil dalam hitungan detik, bukan menunggu siklus berikut.
4. **Penyimpanan**: dua kolom nullable di `devices`: `scanner_status`
   (`connected`/`disconnected`, CHECK) dan `scanner_observed_at`. Migrasi 0366.
   Heartbeat tanpa field `scanner` tidak mengubah kedua kolom itu.
5. **Pembaca**: `GET /api/outlets/:outletId/kitchen/scanner-status` (kontrak yang
   sudah diharapkan web), izin `kds.station.manage` atau izin baca KDS yang sudah
   dipakai halaman KDS. Hasil di tingkat outlet dihitung dari perangkat KDS
   outlet itu yang masih hidup (tidak `isDeviceOffline`, tidak dicabut):
   - ada perangkat dengan `scanner_status = connected` -> `connected`
   - ada perangkat hidup tetapi semuanya `disconnected` -> `disconnected`
   - tidak ada perangkat hidup yang pernah melapor pemindai -> `unknown`
   Nilai `unknown` ditambahkan ke enum respons (web sudah memperlakukannya
   begitu). Perangkat yang mati (heartbeat basi) tidak dihitung, jadi tablet
   mati tidak membuat status "connected" palsu.
6. **Tidak ikut sinkron master data**: ini data ukur perangkat (seperti
   `last_seen_at`), bukan master data; tidak ada event edge baru.

## Urutan rilis

Cloud dan edge di-update dulu, baru shell. Shell baru mengirim `scanner` hanya
setelah keduanya jalan: cloud lama menolak field itu (skema heartbeat strict,
HTTP 400). Bila shell dapat 400 pada heartbeat yang membawa `scanner`, shell
mengulang heartbeat yang sama tanpa `scanner` supaya perangkat tidak tampak
offline.

## Di luar scope

- Nomor tiket pendek (K-024) dan kode "tandai habis" (86): sisa legend-tzyj2,
  kartu terpisah.
- Kode di device shell yang membaca pemindai: repositori shell, bukan di sini.

## Risiko

- Migrasi menambah dua kolom nullable; tabel `devices` FORCE RLS, tanpa
  backfill, jadi tidak perlu `NO FORCE ROW LEVEL SECURITY`.
- Tidak menyentuh uang, auth, maupun pairing perangkat.
