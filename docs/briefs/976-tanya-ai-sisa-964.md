# 976 Tanya AI sisa 964: izin slip terikat sesi, PII cache lama + ai-drafts, sisa kecil
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Review: architect effort xhigh (akses, PII).
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Cabang: worktree-mu dari `origin/ghostex/964-ws-12-tanya-ai-be-tersisa` (ccf30ab9d; belum di m1). Langkah pertama `heavy pnpm worktree:setup` (selama antre, baca kode dan tulis test). Commit dan push tanpa force. Tidak merge, tidak deploy. Migrasi bila perlu: 0525-0529 (nomor kerja).

Kartu (`bd show <id>`; claim dulu):
- legend-3e1ut: izin buka slip TL-09 (10 menit setelah PIN di layar) kini berlaku untuk semua kanal user yang sama. Ikat ke sesi login yang membuka PIN; kanal MCP token tidak boleh membaca slip (tolak dengan pesan "Buka slip di aplikasi").
- legend-vl93z: jawaban ter-cache sebelum scan PII 964 tidak dipindai ulang, dan output `ai-drafts.service.ts` belum dipindai. Pindai saat baca cache (atau invalidasi cache lama saat deploy lewat versi kunci cache), dan pindai output drafts dengan aturan yang sama (pengecualian angka slip milik sendiri tetap).
- legend-4cjn6: (1) PO dari AI tercatat `source: "ai"` (bukan "user"); (2) retry dengan expectedDate/harga berubah tidak boleh menandai permintaan `failed` bila draf PO sudah ada: kembalikan draf yang ada; (3) rate limit MCP sliding window atau token bucket supaya tidak 2x batas lintas menit, tetap fail-closed; (4) bruto TL-05 tanpa reimburse dan service charge; (5) Low reviewer: rollback TL-16 mencatat error (tanpa data pribadi) alih-alih menelan, pesan gagal menyebut sebagian shift mungkin sudah live, gabung duplikasi cancelDraftShiftAssignment.

Jangan sampai bocor: test bukti (1) token MCP milik user yang sama tidak bisa membaca slip walau PIN baru dibuka di layar, (2) sesi lain user yang sama juga tidak, (3) jawaban cache lama berisi PII tersamarkan saat dibaca, (4) drafts berisi PII tersamarkan, (5) rate limit tetap menolak saat Redis error.

Jangan sentuh: `apps/web` kecuali kontrak bersama wajib (catat), payroll (972), POS (974), Duitku (969), recon (967).

Paralel: Explore per kartu + test-writer (gagal-dulu) dalam satu giliran; satu implementer per kartu (file terpisah). Lalu test-runner + architect xhigh bersamaan. Gate (TEAM #9, bukan pnpm check penuh): lint, typecheck API (+web bila shared berubah), test terarah grup ai-*/mcp-*/tl*, root ai-contract/text-contract, `db:generate` kosong, prettier. Satu token heavy per thread (#14).

Laporan: SHA, kartu, migrasi, test, temuan architect, angka subagent (total, puncak, pemegang heavy). Komentari tiap kartu, jangan tutup. Lapor sekali di akhir; jangan akhiri giliran untuk kabar antara.
