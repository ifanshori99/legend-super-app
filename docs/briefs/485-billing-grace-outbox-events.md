# 485 FAC-07 tenggang + event outbox platform

Peran: engineer (`~/.agents/team/roles/engineer.md`). Worktree sendiri dari `origin/ws/6c6-recurring-billing` (berisi `subscriptionAccessPeriod`), cabang `ws/fac07-outbox-events`. Merge train menggabung cabang ini SETELAH 6c6. Rentang migrasi: 0300-0301 (hanya bila perlu).

Kartu (selesaikan semua, lalu lapor):
- legend-9f1p3 (P1, uang): `graceDays` argumen wajib di `subscriptionHasAccess`/`subscriptionAccessPeriod`; konsumen kuota fasilitas (`entitlement_ledger`) memakainya (FAC-07). Test: tenggang 0 dan 3, lewat tenggang tanpa bayar = kuota berhenti, bayar telat tidak memberi kuota ganda. Architect effort xhigh.
- legend-83ll: `session.revoked` lewat outbox + konsumen terdaftar.
- legend-fy5y: emit `tenant.status_changed` / `tenant.package_changed` + konsumen undangan admin.
- legend-n039: kunci blind-index HRIS khusus (`apps/api/src/lib/hris-pii.ts`, `lib/secrets.ts`); rotasi/backfill aman. Architect xhigh (data pribadi).
- legend-jcil: aksi operator teraudit untuk melewati celah urutan outbox (cek dulu apakah perlu tabel audit -> migrasi 0300).

Paralel: Explore 1, test-writer 1, implementer per kartu (file terpisah), reviewer/architect per area. Test terarah lewat `heavy`. Gate lint per cabang. Langkah 1 cek basi (`bd show`, `git log --all | grep`). Laporan: commit, test, angka subagent.
