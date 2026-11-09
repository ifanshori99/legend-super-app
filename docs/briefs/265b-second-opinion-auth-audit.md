# Brief 265b: second opinion untuk jejak audit RBAC dan login staf (legend-wt33, legend-9by4, legend-wq3f)

## Peran

Baca `~/.agents/team/roles/second-opinion.md` dan `~/.agents/team/TEAM.md`.

- Read-only: jangan ubah kode, jangan commit.
- Langkah pertama: pecah tugas, lalu spawn subagent paralel dalam satu giliran.
- Satu run Codex (`gpt-6.1-sol`, effort xhigh karena auth). Brief ini disiapkan, belum dijalankan.

## Repo

- Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/auth-audit-trail`, cabang `ws/auth-audit-trail`.
- Basis diff `d8ea5e0b` (`milestone/m1`). HEAD: lihat `git log -1` di cabang (commit tunggal slice ini).
- Konteks: PRD v1.7 §3.7 Pemberian Role, §3 F6 WhatsApp Reverse OTP, §6 B `audit_logs`; kontrak AUTH-01/02/04/06 di `docs/plan/contracts.md`.

## Diff

```
git diff d8ea5e0b HEAD -- apps/api/src/services apps/api/src/test
```

Berkas berisiko:

- `apps/api/src/services/identity-wa-audit.ts` (baru): `recordLoginAudit`, daftar `LOGIN_AUDIT_SAFE_FIELDS`.
- `apps/api/src/services/identity-login.service.ts`: audit `created`, `rate_limited`, `expired`, `claimed`, `claim_failed`, `cancelled`.
- `apps/api/src/services/identity-wa-inbound.service.ts`: audit `completed`, `rejected`, `expired` di dalam transaksi webhook (`db.transaction` yang membungkus `withTenant` bersarang).
- RBAC: `apps/api/src/services/core-audit-writer.ts` dan `audit-writer.ts` tidak diubah; hanya test (`rbac-audit-writer.test.ts`, `platform-access-api.test.ts`).

Test terkait (boleh dijalankan lewat `LEGEND_TEST_FILES` dari root worktree): `identity-login-audit.test.ts`, `rbac-audit-writer.test.ts`, `platform-access-api.test.ts`, `identity-login.test.ts`.

## Invariant (tingkat K, auth)

1. Baris audit login tidak pernah memuat kode OTP (mentah atau terformat), nonce binding, id/token sesi, IP mentah, atau nomor WhatsApp penuh. Hanya 3 digit akhir nomor (`•••123`, `maskSenderForAudit`, minimisasi data) dan digest IP berkunci.
2. Tiap baris audit ditulis dalam transaksi yang sama dengan perubahan statusnya, kecuali dua jalur best-effort yang disengaja: `rate_limited` (transaksi issue sudah rollback) dan `claim_failed` (sesi gagal dibuat). Periksa apakah ada jalur lain yang bisa mengubah status tanpa audit, atau audit tanpa perubahan status.
3. Audit gagal pada jalur sukses (`created`, `completed`, `claimed`) harus menggagalkan operasinya (fail closed), tidak boleh meninggalkan sesi tanpa catatan. Periksa urutan reservasi klaim dan pembuatan sesi di `pollWhatsAppChallenge`.
4. Isolasi tenant: baris audit login hanya terbaca oleh tenant pemilik (RLS `audit_logs`); `tenantId` baris berasal dari tenant challenge, bukan dari input pengguna.
5. Pesan webhook yang tidak cocok dengan challenge manapun tidak punya tenant, jadi tidak diaudit. Nilai apakah celah ini dapat dimanfaatkan penyerang untuk menebak kode tanpa jejak (rate limit per nomor tetap berlaku).
6. Idempoten: poll berulang, cancel berulang, dan pengiriman webhook ganda tidak menghasilkan baris audit ganda untuk satu peralihan status.
7. `actorId` selalu UUID atau null; `actorType` `system` untuk tamu anonim, `user` hanya setelah nomor terbukti.
8. Audit RBAC: tulis audit ikut commit dan rollback bersama tulis domain; writer null menolak tulis (503), tidak diam-diam melewatkan.
9. Tidak ada perubahan pada logika pemilihan tenant WhatsApp (milik `legend-mbd2`, cabang `ws/tenant-claims`); tandai bila diff menyentuhnya.
10. Tidak ada migrasi.

## Tambahan: rate limit HTTP login-challenges (legend-fc0f2)

Diff (commit terpisah di atas commit senderMasked):

```
git diff 72b17ed2 HEAD -- apps/api/src/app.ts apps/api/src/middleware apps/api/src/test/login-challenge-rate-limit.test.ts
```

Berkas risiko:

- `apps/api/src/middleware/login-challenge-rate-limit.ts` (baru): dua kelas (issue 30 per IP dan 10 per binding per menit; poll/cancel 600 dan 120), counter `createFixedWindowCounter` yang sama dengan `publicRateLimit`, galat 429 `rejectRateLimited`.
- `apps/api/src/app.ts`: pemasangan di `/api/auth/login-challenges` sebelum `guardImpersonatedAuthRoutes` dan `tenantContext`.
- `apps/api/src/middleware/public-rate-limit.ts`: hanya `clientIp` dan `rejectRateLimited` jadi `export`.

Invariant tambahan:

11. Banjir POST melewati batas dijawab 429 tanpa query DB (tanpa `db.transaction`, `pool.query`, `pool.connect`), termasuk dengan cookie sesi palsu, dan tanpa baris `audit_logs` atau `login_challenges` baru.
12. Kelas issue gagal-tertutup: semua POST selain `/:id/cancel` memakai budget issue, tidak peduli huruf besar-kecil, garis miring akhir, atau rute issue baru (mis. `/email`).
13. Tidak ada IP yang dikecualikan secara default (loopback ikut dibatasi); tanpa `TRUST_PROXY` semua klien terlihat sebagai satu IP, nilai apakah itu menjadi kunci lockout satu NAT.
14. Kunci binding hanya dari cookie `login_binding` yang tanda tangannya valid (`readBindingNonce`); cookie palsu hanya dihitung ke IP. Rotasi cookie tidak melewati batas IP.
15. Batas per proses (memori). Beberapa instance API masing-masing punya jendela sendiri; nilai kecukupannya bersama aturan Cloudflare di `docs/deployment.md`.
16. IPv6 per alamat penuh sudah diganti per /64 (kartu `legend-6jgd2`, bagian di bawah). Seorang klien di NAT venue bisa menghabiskan budget poll semua tamu (diterima).
17. Logika AUTH-04 (5 challenge aktif per cookie/IP per 15 menit) tidak berubah.

## Tambahan: kunci IP IPv6 per /64 (legend-6jgd2)

Diff (cabang `ws/ipv6-rate-limit-key`, di atas fd953712):

```
git diff fd953712 HEAD -- apps/api/src/lib apps/api/src/middleware apps/api/src/test
```

Berkas risiko:

- `apps/api/src/lib/client-ip-key.ts` (baru): `clientIpKey(address)`. IPv4 apa adanya; IPv4-mapped IPv6 (`::ffff:a.b.c.d` dan bentuk hex) menjadi IPv4; IPv6 lain menjadi /64 kanonis (mis. `2001:db8:0:1::/64`, zona `%eth0` dibuang); kosong menjadi `unknown`; teks tak valid diambil apa adanya (huruf kecil, maks 64 karakter) dan tidak pernah melempar galat.
- `apps/api/src/middleware/public-rate-limit.ts`: kunci `ip:` dan `write-ip:` memakai helper. Pengecualian `internalIps` tetap membandingkan alamat persis.
- `apps/api/src/middleware/login-challenge-rate-limit.ts`: kunci `ip:` memakai helper.
- `apps/api/src/lib/identity-digest.ts`: `clientIpDigest` memakai helper, jadi hitungan AUTH-04 per IP (`login_challenges.ip_hash`) ikut per /64.

Invariant tambahan:

18. Dua alamat dalam satu /64 berbagi bucket di ketiga tempat (limiter login-challenge, `publicRateLimit` termasuk `write-ip`, hitungan AUTH-04); /64 berbeda tidak.
19. Digest IPv4 tidak berubah (`identityDigest("client-ip", ipv4)`). Digest IPv6 berubah menjadi digest dari /64, baik di `login_challenges.ip_hash` maupun `ip_hash` di `audit_logs`; baris lama yang tersimpan tidak ditulis ulang, jadi baris IPv6 lama tidak cocok dengan hitungan baru (jendela AUTH-04 hanya 15 menit, efeknya hilang sendiri). Digest untuk `::ffff:a.b.c.d` juga berubah menjadi digest IPv4 biasa (terjadi tanpa `TRUST_PROXY` di socket dual-stack, saat `req.ip` berbentuk mapped); jendela AUTH-04 15 menit reset sekali saat deploy dan `ipHash` audit lama tidak tersambung dengan yang baru.
20. Sisa kunci IP mentah di luar cakupan: `edge/link-server.ts`, `routes/staff-pin-sync.routes.ts`, `routes/edge-bootstrap.routes.ts`, `routes/payment-webhook.routes.ts`, `routes/mcp.routes.ts`, dan rate limit Better Auth lewat `CLIENT_IP_HEADER`.
21. Satu /64 adalah satu rumah atau satu pelanggan di hampir semua ISP, jadi pengguna sah di /64 yang sama ikut berbagi budget (diterima, sama dengan NAT IPv4).
22. Sisa risiko desain: penyerang yang memegang /48 atau /56 (mis. /48 gratis dari tunnelbroker) tetap mendapat 65536 atau 256 bucket /64. Mitigasi lanjutan: bucket kedua per /48 dengan batas lebih longgar, atau aturan Cloudflare (`docs/deployment.md`).
