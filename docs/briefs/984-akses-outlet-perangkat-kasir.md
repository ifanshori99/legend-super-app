# 984 Akses: outlet asing di Tanya AI, perangkat alarm support, token kasir perangkat bersama

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Review: architect effort xhigh (akses).
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Cabang: worktree-mu dari `origin/ghostex/981-ulasan-ai-11-modul-mcp` (83dd3da01; punya helper `assertKnownOutlets`; belum di m1). Langkah pertama `heavy pnpm worktree:setup`. Commit dan push tanpa force. Tidak merge, tidak deploy. Migrasi baru 0560-0564 (nomor kerja) bila perlu; 981 memegang 0545-0546.

Kartu (`bd show <id>`; claim dulu):
- legend-xloqn: TL-08 (jalur `manage`) dan TL-20 meloloskan id outlet asing diam-diam. Pakai `assertKnownOutlets` (`read-b/support.ts`), tolak `forbidden` seperti TL-11/TL-21.
- legend-xqkr7: sesi support access dengan grant satu tenant bisa membaca `device_label` perangkat alarm user target di tenant di luar grant lewat `GET /api/identity/push-devices`. Batasi ke tenant yang di-grant; sesi biasa tidak berubah.
- legend-f586w: lanjutan legend-aruta. Di mode perangkat bersama, tolak request POS tanpa token kasir aktif (bukan aksi atas nama pemilik sesi). Termasuk route floor, table-sessions, table-links, kds. Di luar mode perangkat bersama perilaku lama tetap.

Jangan sentuh: refund/recon (980), charge tukar menu dan collect-at-pos (982, cabang `ghostex/982-charge-tukar-menu-refund-void-pos`), payroll/HR (983). File bertumpuk: catat di laporan.

Bukti: test gagal-dulu per kartu: outlet/tenant asing ditolak, support access lintas tenant tidak melihat perangkat, perangkat bersama tanpa token kasir ditolak di tiap route yang disebut, dan alur normal (kasir aktif, sesi biasa) tetap lulus.

Paralel: Explore per kartu + test-writer (gagal-dulu) dalam satu giliran; satu implementer per kartu (file terpisah). Lalu test-runner + architect xhigh bersamaan. Gate (#9): lint, typecheck API, test terarah grup ai-tools/identity/pos-device, `db:generate` kosong, prettier. Satu token heavy per thread. Tunggu job latar dengan satu Monitor yang hanya memicu saat selesai/gagal (tanpa tick).

Laporan: SHA, kartu, migrasi, test, temuan architect, angka subagent (total, puncak, pemegang heavy). Komentari tiap kartu, jangan tutup. Lapor sekali di akhir; jangan akhiri giliran untuk kabar antara.
