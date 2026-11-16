# 946 Perbaikan P1 second opinion 944 (batas basi registry edge)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Akses: architect xhigh atas diff.
Cabang: worktree-mu dari `origin/ghostex/935-foto-penerimaan-stale-edge` (8a661cd90; sedang masuk batch81). Commit dan push tanpa force. Tanpa migrasi kecuali terpaksa (nomor kerja mulai 0445). Tidak merge, tidak deploy.
Laporan SO: `git show origin/qa/second-opinion-akses-935:docs/qa/second-opinion-akses-935.md` (skenario, berkas:baris, usul test). Keputusan CTO: perbaiki keduanya.
- legend-91u09 (P1-1): `POST /api/staff-pins/pos-session` dan jalur perangkat lain yang memakai `registeredDeviceIdOf`/`findActiveDeviceForToken` menolak perangkat tanpa sesi berjalan saat registry hard-stale. Aturan penerimaan satu tempat di jalur autentikasi perangkat; sesi yang memang berjalan tetap bisa menyelesaikan transaksi. Token acting-staff tidak ditulis saat ditolak.
- legend-eewxw (P1-2): `apps/api/src/edge/runtime.ts` status registry "belum siap" terpisah dari "fresh": sesi perangkat baru ditahan sampai checkpoint lokal dimuat dan dinilai (tanpa menunggu cloud); permintaan selama belum siap tidak memperbarui `lastSeenAt`.
Paralel: Explore per kartu + test-writer (test gagal-dulu dari usul test SO) dalam satu giliran, satu implementer per kartu, lalu test-runner + architect xhigh bersamaan.
Bukti: gagal-dulu lalu hijau per kartu; test area edge/device/staff-pins/heartbeat lewat heavy setelah commit terakhir; pra-gate AGENTS.md; typecheck API sekali; architect tanpa P1.
Laporan: SHA, test, temuan architect, angka subagent (total, puncak, pemegang heavy). Komentari kedua kartu.
