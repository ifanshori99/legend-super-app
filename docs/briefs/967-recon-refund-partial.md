# 967 Recon: refund parsial provider + refund transaksi tambahan

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Opus 5.5 high (desain baru di uang). Review: architect effort xhigh (uang, migrasi).
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Cabang: worktree-mu dari `origin/ghostex/60a93dca` (d26caed3c, hasil 958; belum di m1). Langkah pertama `heavy pnpm worktree:setup`. Commit dan push tanpa force. Tidak merge, tidak deploy. Migrasi baru 0505-0509 (nomor kerja; 958 memegang 0436).

Konteks wajib: laporan dan desain 958 di `docs/PROGRESS.md` cabang itu (stamp atomik `provider_refunded_at`, audit `payment.provider_refunded_after_recorded`, 409 `PROVIDER_REFUNDED`, karantina payout).

Kartu (`bd show <id>`; claim dulu):
- legend-30hfs P1: event `payment.refunded` PARSIAL dari provider hanya disimpan envelope-nya. Tandai nilai yang di-refund provider, satu audit + satu alert (pemenang stamp), dan batasi alokasi/refund/approve/payout ke nilai bersih (dibayar dikurangi refund provider). Refund parsial berulang dijumlah, tidak boleh melebihi nilai bayar.
- legend-wourt P2: refund atas transaksi tambahan (id beda dari intent) diabaikan `findBoundIntent` sebagai `REFERENCE_MISMATCH`. Ikat lewat relasi transaksi yang sah; yang tetap tidak cocok tetap `ignored`, bukan diterapkan ke intent lain.

Jangan sampai rugi: test bukti (1) payout outlet tidak pernah melebihi nilai bersih setelah satu atau beberapa refund parsial, (2) refund kita sendiri + refund provider tidak menghasilkan pengembalian ganda, (3) webhook dan poller bersamaan tetap satu alert, (4) refund transaksi tambahan tidak pernah mengenai intent tenant atau order lain. Bila ragu: blok pembayaran, jangan lepaskan.

Jangan sentuh: `services/ai-*` (964), langganan recurring DOIT (965).

Paralel: Explore per kartu + test-writer (gagal-dulu) dalam satu giliran; satu implementer per kartu bila file terpisah. Lalu test-runner + architect xhigh bersamaan. Gate: lint, typecheck API, test terarah grup payment/refund/qris-hold/payout, `db:generate` kosong, prettier.

Laporan: SHA, kartu, migrasi, test, temuan architect, angka subagent (total, puncak, pemegang heavy). Komentari tiap kartu, jangan tutup. Lapor sekali di akhir; jangan akhiri giliran untuk kabar antara.
