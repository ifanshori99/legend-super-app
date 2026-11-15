# Sub-brief 867: EDC agent heartbeat, live calls, produksi (engineer, uang)

Cabang fix/edc-agent-867 (dari 46f9d1bca). File utama: apps/api/src/edge/edc/agent.ts. Tes acuan: apps/api/src/test/edc-failover-861.test.ts (harness + pola 861-G/H). Tanpa migrasi.

## legend-agran (heartbeat kunci outlet)
Kunci advisory outlet dipegang di koneksi khusus (`acquireOutlet`, `locks`/`owned`, handler `lost`). Koneksi yang mati diam-diam (NAT drop, host crash) tidak memicu 'error'/'end', jadi kunci hilang tanpa terdeteksi.
Mau: di timer sweep (`startSweep`) atau timer sendiri per outlet, jalankan `SELECT 1` di `entry.client` dengan timeout; gagal atau timeout -> panggil handler `lost` yang ada (lepas klien, owned.delete, fail-stop `onFatal` bila `liveCalls`>0). Satu heartbeat jalan sekaligus (tak menumpuk), stop saat releaseOutlet/lost/stop. Opsi baru di deps (mis. `lockHeartbeatMs`, `lockHeartbeatTimeoutMs`), default masuk akal, 0 = mati.
Bukti: query macet (tak pernah settle) -> lost dipanggil setelah timeout; ada panggilan di kawat -> onFatal sekali; tak ada panggilan -> hanya outlet tak siap, tanpa onFatal; heartbeat sehat tak mengganggu; stop menghentikan timer.

## legend-h4c2f (hitung panggilan hidup)
`lost` memakai `wires.get(key).size` sebagai `liveCalls`. `trackWire` (agent.ts ~803) membungkus `work`; kalau `work` mencakup tulis DB setelah terminal menjawab, panggilan itu ikut dihitung hidup -> exit memutus tulis bukti approval (row tetap unknown).
Mau: hanya panggilan yang MASIH menunggu adapter dihitung hidup; setelah adapter settle, tulis DB (bukti approval) tidak memicu exit dan harus selesai/tersimpan. Drain `releaseOutlet` tetap menunggu tulis DB itu (jangan dilepas kunci sebelum bukti tersimpan) -- cek aman.
Bukti: kunci hilang saat adapter sudah menjawab tapi tulis DB belum selesai -> tanpa onFatal, row berakhir approved (bukan unknown); kunci hilang saat adapter masih menunggu -> onFatal tetap.
Berurutan setelah agran (file sama).

## legend-kwy6d (pasang di produksi)
Tidak ada pemanggil `createEdcAgent` di kode produksi (hanya tes). Pasang di proses produksi (worker; atau proses edge bila itu pemilik terminal: pilih yang benar dari kode, jelaskan di laporan) dengan restart oleh supervisor setelah `process.exit(1)` dari onFatal. Dokumentasikan di docs/deployment.md (bagian EDC/edge): siapa merestart, kebijakan restart (systemd Restart=always / docker restart policy), apa yang terjadi pada marker kawat (dibiarkan; hanya proses lewat jendela late-response yang membersihkan), satu agent per outlet. Tambah unit/compose/contoh bila repo punya pola (deploy/edge). Env baru divalidasi di config/env.ts.

## Jangan sampai rugi (wajib terbukti test)
1. Tidak ada sale kedua: setelah kunci hilang / fail-stop, proses lain atau proses sama tidak mengirim sale yang sama lagi.
2. Marker kawat (`sale_wire_open_at`) tidak dibersihkan proses lain sebelum jendela late-response lewat.
3. Bukti approval tersimpan (row approved, bukan unknown) bila adapter sudah menjawab.
Bila ragu: aturan yang membatasi pembayaran; bawa ke CTO.
