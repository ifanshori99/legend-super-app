# 1061 Status edge ke cloud: slice S1-S5 (legend-uux9k, 0cjzz, eo3lc, m8vf0, n5u8w)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Tingkat K (protokol edge-cloud + akses lintas outlet): architect xhigh sekali di akhir.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran: test-writer gagal-dulu dari §6 (T1-T28), implementer S1 dulu; sesudah S1 hijau, implementer S2, S3, S4 paralel (berkas tidak bertumpuk), lalu S5.
Desain WAJIB diikuti: docs/design/edge-status-cloud.md (commit 4ee135f1b di ux/customer-order-benchmark; salin ke cabangmu). Jangan merge wip/1041-hard-stale.
Base: origin/milestone/m1. UI S5 dari origin/ui/tenant-config 84060e4ae + 8c596b8a8 (apps/web/src/features/ws02-edge/*), sambungkan ke API asli tanpa mengubah desain yang disetujui founder. Migrasi kerja 0678 (0679 cadangan).
- S1 uux9k: tabel edge_node_alerts + kontrak bersama (DTO §3.2).
- S2 0cjzz: alarm hard_stale lewat event edge_node_alarm.raised/cleared di aliran edge_to_cloud, ACK sesudah commit, dedup edge_received_events, scope dari kredensial edge.
- S3 eo3lc: GET /api/edge-node-status, izin report.operational.view, hanya outlet yang dijangkau pemanggil.
- S4 m8vf0: simpan alarm rotasi struk (savepoint, node primary, tutup sesudah 24 jam tanpa alarm).
- S5 n5u8w: layar web Status edge pakai API asli.
Keputusan CTO: tenant_admin TIDAK diberi report.operational.view (ikut menu yang disetujui). Ambang alarm "edge offline" (legend-5ab0l) menunggu founder, jangan dikerjakan.
Bukti: test terarah T1-T28 (sebut berkas), prettier/eslint, typecheck API + web lewat heavy, e2e mock terarah S5 (heavy --browser, screenshot 360/1280), text-contract, db:generate kosong. Commit, push tanpa force. Laporan sekali di akhir: perilaku, test, temuan architect, SHA, angka subagent (total, puncak, pemegang heavy).
