# 556 Second-opinion Codex: kontrak HRIS + migrasi 0287
Peran: second-opinion (~/.agents/team/roles/second-opinion.md). Read-only, jangan edit/commit. Jangan jalankan `heavy` kecuali sangat perlu.
1. Cabang ws/hris-contract (0fb9af48, worktree .worktrees/hris-contract, basis origin/ws/hris-misc) vs origin/ws/hris-misc: kartu legend-je1f (serverTime QR), legend-bf20 (selfie transport, scanner menolak), legend-zygi (enam POST master HRIS, idempotensi, mask gaji saat replay).
   Cari: karyawan bind/unggah untuk orang lain, lintas tenant/outlet, waktu klien dipercaya, data gaji/NIK bocor di respons atau log, replay idempoten membuka data, file selfie terbaca tanpa izin.
2. Kartu legend-bi7yu: migrasi 0287 di origin/milestone/m1 (e9bbd9ea), FK dipindah inline ke CREATE TABLE oleh merge train. Bandingkan dengan versi cabang asal (git log -- apps/api/drizzle/0287*): ON DELETE/ON UPDATE sama, tidak ada FK hilang, aman upgrade dari m1 lama.
Laporan: P0-P3, file:line, skenario, fix. Maks 400 kata.
