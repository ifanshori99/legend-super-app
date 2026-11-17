# 981 Tabel ulasan pelanggan + AI-11 ringkasan ulasan + modul MCP ditegakkan
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Review: architect effort xhigh (migrasi, akses, PII).
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Cabang: worktree-mu dari `origin/ghostex/ee902477` (132131605; 964 + 976, belum di m1). Langkah pertama `heavy pnpm worktree:setup` (selama antre, baca kode dan tulis test). Commit dan push tanpa force. Tidak merge, tidak deploy. Migrasi baru 0545-0549 (nomor kerja).

Kartu (`bd show <id>`; claim dulu):
- legend-vqicf: tabel ulasan pelanggan (tenant, outlet, order/reservasi opsional, rating, teks, sumber, status moderasi) dengan RLS tenant+outlet, untuk antrean dasbor reviews. Contract zod di shared, service + route ber-izin, filter tenant di SQL. Teks ulasan diperlakukan sebagai PII (tidak dilog).
- legend-39d.5: AI-11 ringkasan ulasan (sebelumnya terblokir karena tabel belum ada) memakai tabel di atas: tool read-only, hanya outlet yang boleh dilihat peran itu, scan PII output seperti 964/976.
- legend-hbuq3: tegakkan modul `mcp` (feature flag tenant) di jalur MCP: tenant dengan modul mati ditolak di semua route MCP, tanpa bocor info.
Bila kartu menyebut keputusan produk yang belum ada (mis. siapa boleh memoderasi), pilih yang membatasi dan tulis di laporan.

Bukti: test gagal-dulu per kartu; isolasi tenant/outlet (SQL + RLS), peran tanpa izin ditolak, ringkasan AI tidak memuat data pribadi pelanggan, modul MCP mati menolak semua tool.

Jangan sentuh: refund/recon (980), payroll, POS kas/harga, edge (978), payment QR/Duitku, `apps/web` kecuali kontrak bersama wajib (catat).

Paralel: Explore per kartu + test-writer (gagal-dulu) dalam satu giliran; implementer per kartu (39d.5 setelah skema vqicf ada; boleh mulai dari kontrak). Lalu test-runner + architect xhigh bersamaan. Gate (TEAM #9, bukan pnpm check penuh): lint, typecheck API + web (shared berubah), test terarah grup ai-*/mcp-*/reviews/rls, root ai-contract/text-contract, `db:generate` kosong, prettier. Satu token heavy per thread (#14).

Laporan: SHA, kartu, migrasi, test, temuan architect, angka subagent (total, puncak, pemegang heavy). Komentari tiap kartu, jangan tutup. Lapor sekali di akhir; jangan akhiri giliran untuk kabar antara.
