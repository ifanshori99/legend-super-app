# Brief: second-opinion — klaim lintas tenant (legend-mbd2, legend-t57t)

## Peran

Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti. Read-only: jangan edit atau commit.

## Repo

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/tenant-claims`, cabang `ws/tenant-claims`. Rentang: `git diff milestone/m1...ws/tenant-claims -- apps/api packages/shared ':!apps/api/src/test'`. Test hanya dibaca bila perlu bukti.

## Berkas

- Migrasi `apps/api/drizzle/0178_tenant_claims.sql` (sumber SQL tangan: `apps/api/src/db/schema/platform-integrations.custom.sql`)
- Schema `apps/api/src/db/schema/platform-integrations.ts`, `platform-domains.ts`
- `apps/api/src/services/platform-integration.service.ts` (`upsertIntegration`)
- `apps/api/src/services/org.service.ts` (`addDomain`, `verifyDomain`), `org-resolve.service.ts`, `routes/org.routes.ts`, `config/env.ts`
- `packages/shared/src/platform/domains.ts`, `errors.ts`, `endpoints.ts`
- Test: `apps/api/src/test/whatsapp-number-claim.test.ts`, `tenant-domain-claim.test.ts`

## Fokus

- WhatsApp: dua tenant tidak bisa sama-sama aktif dengan nomor atau `phoneNumberId` yang sama, termasuk format berbeda (`0812…`, `+62 812…`) dan simpan serentak. Fungsi SQL `app.normalize_wa_number` / `app.whatsapp_routing_key` benar-benar sama dengan `normalizeWhatsAppNumber` dan `resolveWhatsAppChannel`. Jalur tulis lain yang bisa mengaktifkan integrasi whatsapp tanpa lewat index (outlet-level, status change) dan dampaknya ke login.
- Migrasi: data lama yang bentrok membuat migrasi gagal dengan pesan jelas, tidak diam-diam; fungsi IMMUTABLE aman dipakai index (search_path, hak EXECUTE `legend_app`).
- Domain: klaim belum terverifikasi tidak memblokir pemilik sah; hanya satu baris terverifikasi per host; `resolveHost` dan Caddy ask (`isVerifiedTenantHost`) tidak pernah melayani baris belum terverifikasi; hostname di bawah platform domain ditolak (termasuk huruf besar, titik di akhir, port); verifikasi TXT tidak bisa dipalsukan (token per baris, cocok persis, error DNS = gagal). RLS `tenant_domains` (SELECT terbuka) tidak membocorkan hal yang membantu penyerobotan.

## Effort

xhigh (akses antar tenant).

## Laporan

Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal konkret, saran. Tidak ada temuan: satu baris.

## Larangan

Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
