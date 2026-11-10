# Brief: merge train batch48c ke milestone/m1

Lanjutan batch48b. Pola sama dengan brief 396 (baca bagian gate dan batas kerja ulang di sana). Basis m1 46352cd5.

## Urutan merge `--no-ff` (cek tip tiap cabang sama dengan di bawah)
1. ws/fe-small-tests 11811e3f
2. ws/u37u3-platform-sync 4c87a3bc (UI disetujui founder)
3. ws/fe-badge-theme f2815e9a
4. ws/tenant-config-export 30764f2c
5. ws/print-agent 7315011f
6. ws/ws01-staff-access 6f300150, lalu ws/ebt9f-me-outlets d515f3fc, lalu ws/outlet-context-rollout a7af0003
7. ws/duitku-codex-fix 1b301b15, lalu ws/s5jup-duitku 008cbd93
8. ws/hris-pii-pin 8305fdc3 (migrasi 0257_payslip_pins, when 1794430000000)
9. ws/refund-recovery-fix 00caa599

## Migrasi
Nomori ulang semua migrasi baru dari 0242, `when` +1000000 mulai 1794323000000, pakai `scripts/migration-renumber.mjs` (apply, lalu `check --from-idx 242`). Snapshot dibuat ulang; `db:generate` kosong tiap merge. Di akhir: snapshot drizzle final dibuat ulang dari skema penuh dan `db:generate` kosong.

## Paralel
3 Explore paralel sebelum merge (peta konflik: web Providers/area-frame, device/staff access, pembayaran Duitku vs refund). Test gagal dibagi ke beberapa implementer sekaligus (file tidak bertumpuk).

## Gate
typecheck 3 paket, lint, satu `heavy pnpm test` penuh SETELAH semua perbaikan (bukan sebelum), e2e, satu architect effort xhigh atas diff migrasi saja. Flake dikenal: menu-print-db, tax-api ORD-03 (rerun sendiri).

## Lapor
Tabel migrasi (baru, tag, asal, cabang, when), m1 lama ke baru, hasil gate, risiko. Hapus worktree cabang yang sudah masuk dan bersih.
