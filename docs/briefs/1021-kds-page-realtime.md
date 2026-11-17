# 1021 KDS: layar memakai client realtime + reconnect 1008 (legend-t0m89)

Peran: ui-engineer (baca ~/.agents/team/roles/ui-engineer.md dan ~/.agents/team/ui-standard.md). Sonnet 5.5 (tugas kecil), effort high. Tingkat K (akses): review satu subagent architect effort high.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore kds-page + hook, test-writer, implementer).

Base: `ghostex/1018-kds-ws-subprotocol-keep-alive` (f854663f9). Cabangmu antre SESUDAH 1018.
Kerja: (1) pasang `apps/web/src/features/ws04-kds/use-kds-realtime.ts` ke `kds-page.tsx`; pembaruan realtime menyegarkan query KDS, polling yang ada tetap jadi cadangan. (2) `kds-realtime.ts:202-205`: saat close 1008 setelah terbuka (ganti kasir, token 12 jam habis), baca ulang token dan reconnect sekali; gagal lagi = tampilkan status putus + minta PIN, jangan loop. (3) test real-socket: token kasir dicabut di tengah koneksi -> koneksi ditutup dan tidak menerima event lagi. Status koneksi kecil sesuai pola layar KDS; teks baru masuk katalog.
Bukti: test web (client + halaman), test API real-socket, prettier/eslint, typecheck web + API lewat heavy, screenshot 1280 tersambung/terputus ke docs/review/img/ui1021-*. Commit, push tanpa force, hapus worktree subagent milikmu.
Laporan sekali di akhir (Monitor, bukan sleep loop; jangan akhiri giliran untuk kabar antara): perilaku, test, temuan architect, SHA, angka subagent.
