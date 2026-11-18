# 1041 Edge status dan alert ke cloud (Codex S, WS-02)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Codex high. Codex tidak menjalankan bd; isi kartu di bawah. Base origin/milestone/m1.

## legend-uvnll
◐ legend-uvnll · Edge: peringatan batas keras replika perangkat harus sampai ke cloud   [P2 · IN_PROGRESS]
DESCRIPTION
Peringatan edge_device_registry.hard_stale (legend-2lgu) hanya tertulis ke  
outbox notifikasi lokal edge, sedangkan aliran notifikasi hanya ada di cloud
(edge/mode.ts, edge/runtime.ts). Pemilik tidak diberi tahu saat edge        
terputus lebih dari 72 jam; hanya staf yang melihat panel Koneksi.          
Perbaikan: tambahkan flag deviceRegistryHardStale ke heartbeat link edge dan
beri peringatan dari cloud, mengikuti pola catalogStale. Temuan architect   
review legend-2lgu (P2).                                                    
DISCOVERED FROM
◊ ✓ legend-2lgu: Edge: batas keras replika device basi (default 72 jam, bisa diatur) + tampil status basi di panel edge web P2

## legend-kkojp
◐ legend-kkojp · WS-02 BE: push fallback untuk alert panik yang dibuat langsung di cloud (tanpa edge)   [P2 · IN_PROGRESS]
DESCRIPTION
Temuan architect review legend-kmjax: queuePanicAlertEvent (services/panic- 
alert-outbox.ts:122) return awal bila tidak ada edge box, jadi alert dari   
panic-relay.service.ts:319 di cloud-only tidak memicu notifikasi            
panic_alert.raised. Perlu antri event notifikasi di jalur cloud-only. Juga: 
tes alur penuh worker consumeOutbox -> consumer -> delivery attempt.        

## legend-ph62j
◐ legend-ph62j · Status edge back-office (s7szu lanjutan): layar tabel node + API cloud + nama node di kontrak   [P2 · IN_PROGRESS]
DESCRIPTION
Mockup design/mockups/backoffice/receipt-run-s7szu.html disetujui founder   
(Q35). Sekarang alert hanya di POS /operasional/koneksi.                    
NOTES
UI dibangun di ui/tenant-config (mock, menu hanya mock). Sisa: API cloud    
daftar node + nama node di kontrak.                                         
COMMENTS
2026-11-13 01:03 Ilham fadillah Anshori
UI Status edge (ui/tenant-config 8c596b8a) disetujui founder Q96; tinggal   
API cloud daftar node.                                                      

Batas: tanpa uang, tanpa ubah auth/akses, tanpa migrasi data (migrasi skema bila perlu: nomor kerja 0680-0681). Jangan sentuh refund, kas/supplier, payroll, ws04-pos-kasir, .github.
Bukti: test gagal-dulu per kartu, test terarah lewat heavy (sebut berkas), prettier/eslint, typecheck API lewat heavy, db:generate kosong. Commit, push tanpa force. Laporan sekali di akhir: perilaku per kartu, test, SHA.
