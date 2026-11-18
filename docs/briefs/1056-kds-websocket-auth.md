# 1056 KDS websocket + layar pelanggan: pengerasan akses perangkat bersama
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Tingkat K (akses): architect xhigh sekali di akhir.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran: Explore (kds-realtime-auth.ts, gate perangkat bersama, route customer-display), test-writer gagal-dulu per kartu, implementer per kartu (berkas tidak bertumpuk).
Base: origin/milestone/m1. Migrasi kerja 0670-0671 hanya bila perlu.
Urutan: legend-a6aq6 dulu (6 test gagal device-shared-mode.test.ts ACTING_STAFF_NOT_ALLOWED), lalu paralel:
- legend-lzydj: perangkat yang dicabut bisa reconnect ke websocket KDS sebagai owner (kds-realtime-auth.ts:164, registry hanya dicek bila anySharedDeviceActive). Selalu cek registry.
- legend-wa9n7: websocket KDS (kds-realtime-auth.ts:88) dan /api/auth/* lolos gate perangkat bersama.
- legend-t0m89: sambungkan use-kds-realtime ke kds-page, reconnect sekali pada 1008, test token kasir dicabut di tengah koneksi.
- legend-dgtz0: preview layar pelanggan bisa membaca tagihan outlet lain tanpa token kasir.
JANGAN ubah resolveActingStaff / requireActingStaffOnSharedDevice dan route uang tablet (dikerjakan thread 1054 paralel). Bila wajib, laporkan dulu.
Test: perangkat dicabut ditolak, tenant/outlet lain ditolak, perangkat pribadi tetap jalan.
Bukti: test terarah (sebut berkas), prettier/eslint, typecheck API + web lewat heavy, e2e mock terarah bila web berubah, db:generate kosong. Commit, push tanpa force. Laporan sekali di akhir: perilaku, test, temuan architect, SHA, angka subagent (total, puncak, pemegang heavy).
