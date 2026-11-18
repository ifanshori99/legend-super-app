# 1043 Q29: allowlist layar tablet bersama (legend-iq0jz)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Opus 5.5 high (desain baru di akses). Tingkat K (akses): architect effort xhigh sekali di akhir.
Langkah pertama: spawn paralel: Explore (mode perangkat bersama: migrasi 0457-0459, `middleware/acting-staff.ts` requireActingStaffOnSharedDevice, `db/schema/session.ts`, route web reservasi, Tanya AI KDS, operasional, fasilitas), test-writer gagal-dulu API + web, implementer API dan implementer web terpisah.
Base: origin/milestone/m1. Founder 18 Nov Q29: di tablet bersama, Reservasi BUKA, Tanya AI di KDS BUKA, layar operasional dan fasilitas TUTUP. Default tolak (allowlist), bukan denylist: route baru otomatis tertutup di tablet bersama.
Tegakkan di API (middleware, termasuk websocket dan server function SSR) dan di web (guard route + menu tersembunyi; hiding UI bukan pengecekan). Jangan ubah aturan PIN kasir yang ada.
Test: tiap layar buka/tutup di tablet bersama vs perangkat pribadi; route tak terdaftar ditolak; tenant/outlet lain. Migrasi kerja 0677-0678 hanya bila perlu.
Bukti: test terarah (sebut berkas), prettier/eslint, text-contract bila ada teks baru, typecheck API + web lewat heavy, db:generate kosong. Commit, push tanpa force. Laporan sekali di akhir: perilaku, test, temuan architect, SHA, angka subagent (total, puncak, pemegang heavy).
