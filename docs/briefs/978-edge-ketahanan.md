# 978 Edge: ketahanan pull katalog, purge saat jam tidak terpercaya, notifikasi throttle PIN, event refused
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Review: architect effort high (akses edge; naik xhigh bila menyentuh uang/promo).
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Cabang: worktree-mu dari `origin/milestone/m1` (1c185edc0; batch83 sedang gabung, rebase tidak perlu). Langkah pertama `heavy pnpm worktree:setup` (selama antre, baca kode dan tulis test). Commit dan push tanpa force. Tidak merge, tidak deploy. Migrasi bila perlu: 0530-0534 (nomor kerja).

Kartu (`bd show <id>`; claim dulu; file terpisah, satu implementer per kartu):
- legend-l1wux [bug]: `pullCatalog` per stream belum diserialkan; dua pull bersamaan bisa membuka gate promo di atas snapshot parsial. Serialkan per stream (lock/antrean), gate promo hanya terbuka setelah snapshot lengkap.
- legend-4sesc [bug]: purge audit/PIN edge melewati sweep saat jam edge tidak terpercaya. Pastikan sweep tertunda dengan aman (tidak menghapus terlalu awal, tidak menyimpan selamanya), lanjut saat jam terpercaya.
- legend-62jtd: notifikasi `staff_pin.device_throttled` ditulis di DB edge; pastikan sampai ke manajer outlet di cloud (outbox/sync), tanpa PIN atau data rahasia di payload.
- legend-ngyd7: pulihkan event edge yang ditandai refused di jendela m1 (`AuditUnavailableError`): jalur replay idempoten untuk event itu, tanpa menerapkan ulang yang sudah diterapkan.

Bukti: test gagal-dulu per kartu; (1) dua pull bersamaan tidak pernah membuka gate di atas snapshot parsial, (2) purge tidak jalan saat jam tidak terpercaya dan jalan setelah terpercaya, (3) notifikasi throttle sampai ke manajer outlet yang benar saja (tenant/outlet lain tidak), (4) replay event refused idempoten.

Jangan sentuh: payroll (972), recon/refund (967), `services/ai-*` (976), POS kas/harga (974, sudah antre), payment QR/Duitku.

Paralel: Explore per kartu + test-writer (gagal-dulu) dalam satu giliran; satu implementer per kartu. Lalu test-runner + architect bersamaan. Gate (TEAM #9, bukan pnpm check penuh): lint, typecheck API (+web bila shared berubah), test terarah grup edge-*/staff-pins/device/catalog/promo-gate, `db:generate` kosong, prettier. Satu token heavy per thread (#14).

Laporan: SHA, kartu, migrasi, test, temuan architect, angka subagent (total, puncak, pemegang heavy). Komentari tiap kartu, jangan tutup. Lapor sekali di akhir; jangan akhiri giliran untuk kabar antara.
