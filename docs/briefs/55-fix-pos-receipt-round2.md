# Brief: fix putaran 2 — ws/pos-receipt (temuan second-opinion Codex)

Cabang `ws/pos-receipt` (HEAD 863b3ac), worktree `.worktrees/pos-receipt`. Kartu legend-93a. Merge `main` dulu; pastikan `node_modules` bukan symlink. Tiap fix butuh test yang gagal sebelum fix.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (file tidak bertumpuk).

1. **P1 pos-receipt.service.ts:470** — merge run offline menerima `lastNumber=3` dengan hanya struk `#3` (gap `[1,2]`), lalu batch terlambat `#1/#2,lastNumber=2` ditolak `RECEIPT_SEQUENCE_REGRESSION`. Fix: validasi kelengkapan rentang sebelum memajukan sequence; izinkan backfill idempoten untuk nomor yang hilang; test batch sparse dan terbalik.
2. **P2 pos-receipt-document.ts:71** — dokumen struk memakai nama/alamat outlet terkini, jadi struk `issued` berubah tampilan. Fix: snapshot immutable header outlet (nama, alamat, NPWP, dll.) saat terbit; cetak, PDF, email, e-receipt memakai snapshot.
3. **P2 app.ts:68 / error-handler.ts:101** — `/api/public/receipts/<TOKEN>%ZZ` mencetak token lengkap di `URIError.message` dan stack. Fix: tangani encoding URL rusak dengan error aman (400 tanpa echo path), sanitasi serializer error; test penangkapan log memastikan token tidak muncul.

## Bukti selesai
Test terkait lulus, `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check` lulus (satu gerbang penuh setelah perubahan terakhir), `git status` bersih, subagent reviewer konteks segar cek diff. Commit lokal merujuk legend-93a. Jangan push, jangan merge. Lapor per temuan.
