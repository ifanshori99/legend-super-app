# 857 perbaikan temuan architect (CTO, 15 Nov)

Cabang A fix/inv-acct-857 (0550e0b3f):
- P2: packages/shared/src/accounting/coa.ts:231 `inventory_price_variance` tanpa entri POSTING_ROLE_ALLOWED_TYPES, jadi bisa dipetakan ke akun AP/persediaan (utang supplier lebih besar, INV-01 rusak). Tambah `inventory_price_variance: ["expense", "revenue"]`. Test: akun asset/liability ditolak 422 (apps/api/src/test/purchase-return-avg-variance.test.ts), gagal-dulu.

Cabang B fix/finance-dp-857 (d2917edaf):
- P2: apps/api/src/services/accounting-finance-exceptions.service.ts:577-593 ranking menutupi DP receipt yang missing di balik tender delivered. Ubah: missing (DP atau tender) di atas delivered, atau kembalikan state semua intent. Test "DP missing vs tender delivered" di apps/api/src/test/accounting-finance-exceptions.test.ts, gagal-dulu.

P3 dicatat jadi kartu, jangan dikerjakan. Pra-gate AGENTS.md. Commit + push tanpa force kedua cabang. Lapor sha.
