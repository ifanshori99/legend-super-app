# Hosting the monorepo

Deploy two Node.js services — the API and the web app — connected to a persistent PostgreSQL service. Neither app keeps data on its filesystem.

## Environment and data policy

PRD v1.7 §3 (Environment & Deployment) and §7 require separate development,
staging and production environments. Only production may contain real data.
The settings below describe the deployment and are separate from `NODE_ENV`,
which selects Node runtime behavior. Set them consistently for every service.

| Environment | `DEPLOYMENT_MODE`         | `EDGE_MODE` | `DATA_CLASSIFICATION`                                               | Data                           |
| ----------- | ------------------------- | ----------- | ------------------------------------------------------------------- | ------------------------------ |
| Development | `development`             | `false`     | `synthetic`                                                         | Synthetic only                 |
| Staging     | `staging`                 | `false`     | `synthetic`                                                         | Synthetic only                 |
| Production  | `production`              | `false`     | `synthetic` or `real`                                               | Real data permitted            |
| Edge node   | Corresponding environment | `true`      | `synthetic` outside production; `synthetic` or `real` in production | Same policy as its environment |

The defaults are `development`, `false`, and `synthetic`. Explicitly set the
appropriate values in each deployment; an edge node is a topology, not an
exception to the environment's data policy. The edge topology requires the same web image configured with `EDGE_MODE=true`;
its offline provisioning and synchronization remain separate work.

Use fictional synthetic menus, 30 employees, and transactions for load and
payroll testing. Do not copy production databases, backups, customer or employee
records into development or staging, including masked or anonymized copies as a
substitute for synthetic data. Keep secrets in environment variables or a secret
manager, never in the repository.

Classification is a declaration, not a way to detect actual data. Import code
must classify its input honestly and call the real-data import guard before it
reads or writes the data; deployment and database access controls must also
prevent bypassing the application. Setting `DATA_CLASSIFICATION=synthetic` does
not make a production dump synthetic.

## Startup validation

Every runtime validates the three settings when its process starts, using one
schema in `@starter/shared/env` (`packages/shared/src/env/index.ts`), so a
service cannot run while disagreeing with the others about its data policy.
The check prints the offending setting names and messages — never the values —
and exits non-zero before the service accepts traffic.

| Runtime | Where the check runs                                                                          |
| ------- | --------------------------------------------------------------------------------------------- |
| API     | `apps/api/src/config/env.ts`, imported by the server entry                                    |
| Web     | `apps/web/server/plugins/deployment-env.ts` (built server) and `apps/web/src/server.ts` (dev) |
| Worker  | `apps/api/src/worker-main.ts` validates the deployment settings before starting work          |
| Edge    | The web runtime validates the same settings with `EDGE_MODE=true`                             |

The web app needs two entry points because it has two servers. The built server
(`node .output/server/index.mjs`, produced by Nitro) opens its port before it
loads the app — its default entry is a lazy handler — so a Nitro runtime plugin
in `apps/web/server/plugins/deployment-env.ts` runs the check while the process
starts, and a bad deployment exits before the port opens. `vite dev` uses
TanStack Start's own server instead, whose entry is `apps/web/src/server.ts`;
there the check runs when the server entry loads, on the first server render.
Both import `apps/web/src/lib/env.server.ts` (the module that reports and
exits), and `vite.config.ts` registers the plugin under `nitro.plugins`;
`tests/deployment-env.test.mjs` fails if either import or that registration is
dropped. TanStack Start strips `.server.ts` modules from the browser bundle, so
the check never reaches a client.

A future worker or edge entrypoint repeats the same three lines:

```ts
import { assertDeploymentEnv } from "@starter/shared/env";

// Before the loop or HTTP handler that serves work.
const settings = assertDeploymentEnv(process.env);
if (settings.EDGE_MODE) {
  // Edge-only wiring: local database, device sync, offline queue.
}
```

The module also exports `parseDeploymentEnv` (returns problems instead of
throwing, for a doctor command or a health endpoint) and
`assertDataImportAllowed` (the real-data import guard described above, already
used by the API).

## Domains and cookies

The browser calls the API directly with cookies, and the web server reads the same cookie during server rendering. Put both apps on subdomains of one site and share the cookie with `COOKIE_DOMAIN`:

| App | Example origin            |
| --- | ------------------------- |
| API | `https://api.example.com` |
| Web | `https://app.example.com` |

Unrelated domains (e.g. `app.example.com` and `example-api.net`) are not supported: the web server would never receive the session cookie. `pnpm run doctor` checks this rule against your settings. Better Auth marks cookies `Secure` automatically when `BETTER_AUTH_URL` is HTTPS.

`COOKIE_DOMAIN` sends the session cookie to **every** host under that domain, not just these two. Anything else served there — a marketing site on a third-party platform, user uploads, preview deployments — receives your users' sessions. Host such content on a different domain, or give the app its own parent (e.g. `api.app.example.com` and `web.app.example.com` with `COOKIE_DOMAIN=.app.example.com`).

## Production environment

**API** (private values through your host):

```dotenv
NODE_ENV=production
DEPLOYMENT_MODE=production
EDGE_MODE=false
DATA_CLASSIFICATION=real
# Pay approved refunds through DOIT. Default off. The API and the worker must
# have the same value; see "Worker transport and notification settings".
# DOIT_REFUNDS_ENABLED=false
DATABASE_URL=postgresql://user:password@database-host:5432/app
BETTER_AUTH_SECRET=your-random-secret-at-least-32-characters
# Staff device PINs (PRD §3 F6): its own secret, never derived from
# BETTER_AUTH_SECRET. Required in production; rotating it invalidates every
# stored PIN, so staff must set a new one after a rotation.
STAFF_PIN_PEPPER=another-random-secret-at-least-32-characters
BETTER_AUTH_URL=https://api.example.com
WEB_URL=https://app.example.com
COOKIE_DOMAIN=.example.com
# Behind a load balancer or reverse proxy (hop count, or a subnet list; never true):
TRUST_PROXY=2
# Optional: extra browser origins allowed to call the API with cookies.
# TRUSTED_ORIGINS=https://admin.example.com
# Optional direct connection when DATABASE_URL uses a pooler:
# MIGRATION_DATABASE_URL=postgresql://user:password@direct-host:5432/app
# Optional: member sign-in email over SMTP (legend-k2l). SMTP_HOST, SMTP_USER,
# SMTP_PASS and EMAIL_FROM together or none; none = email sign-in answers 503.
# The same sender mails the password reset link (legend-1255): without it
# POST /api/auth/request-password-reset answers 503 and the web hides the link.
# Port 465 uses implicit TLS (SMTP_SECURE=true); SMTP_SECURE=false requires STARTTLS.
# SMTP_HOST=smtp.example.com
# SMTP_PORT=465
# SMTP_SECURE=true
# SMTP_USER=replace_me
# SMTP_PASS=replace_me
# EMAIL_FROM=masuk@example.com
# Optional: member Google sign-in (legend-k2l). Both or neither; neither = off.
# Redirect URI: <BETTER_AUTH_URL>/api/auth/callback/google
# GOOGLE_CLIENT_ID=replace_me
# GOOGLE_CLIENT_SECRET=replace_me
```

**Web**:

```dotenv
NODE_ENV=production
DEPLOYMENT_MODE=production
EDGE_MODE=false
DATA_CLASSIFICATION=real
# Build time — inlined into the browser bundle:
VITE_API_URL=https://api.example.com
# Runtime, optional — the address the web server uses to reach the API privately:
API_INTERNAL_URL=http://api:4000
```

`NODE_ENV=production` switches both servers to JSON logs and the web app to sending HSTS. The Docker images set it; set it yourself everywhere else.

`TRUST_PROXY` matters: the API resolves the client IP from it and hands that IP to Better Auth and the public rate limiter for per-IP limits on sign-in/sign-up and the guest reads. Set the number of proxies in front of the API (usually `1`, `2` when Cloudflare sits in front of your reverse proxy) or their subnets. The API refuses `true`, which would trust any `X-Forwarded-For` a client sends and let it choose the IP its attempts are counted under. Without a proxy, leave it unset (the socket address is used and client-supplied `X-Forwarded-For` is ignored).

Keep provider-required TLS settings. Do not disable certificate verification. The example credentials are placeholders, not defaults.

## Release steps without Docker

Before `db:migrate`, complete the [subscription duplicate release gate](#gerbang-rilis-duplikat-langganan-sebelum-migrasi-0301-legend-gi697)
when the package includes the live customer/plan index (originally 0301,
rechained to 0266 on `milestone/m1`). This gate also applies before the Docker
migrator runs.

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
VITE_API_URL=https://api.example.com pnpm build
NODE_ENV=production node apps/api/dist/server.js           # API
NODE_ENV=production node apps/web/.output/server/index.mjs # Web
```

### Refund migrations: stop, migrate, start (legend-uvjqq)

A release that contains 0496 (`provider_refund_id_kind`) or any other refund
migration must not be rolled out rolling. Stop the API and the worker, run
`pnpm db:migrate`, then start both again.

Why: 0496 replaces the 3-column unique key of `payment_provider_refunds` with a
4-column key that carries `refund_id_kind`, and adds a CHECK on the kind of
`refund_recon_holds`. An old writer still running during the migration uses
`ON CONFLICT` on the 3 columns, which no longer matches any unique key, so its
insert fails; it also writes holds with an id but no kind, which the CHECK
rejects. A new writer against the old schema has no `refund_id_kind` column.

Rollback is a restore of the backup taken before the migration, not a down
migration. After the start, the worker retries the webhook events that were
held back while the services were stopped; check that the queue drains.

### PTKP history backfill: after 0520, before the next payroll simulate (bead 1223)

A release that contains 0519/0520 (`employee_ptkp_history`) needs a one-shot
backfill, run ONCE: right after `pnpm db:migrate`, before anyone simulates a
payroll run, before any HR PTKP correction (`PUT /api/hris/employees/:id/ptkp`)
and before 1 January (it reads the running year's locked slips). The script
refuses a tenant where an HR correction is already audited; `--force` overrides
that only when the correction may be overwritten. Migration 0519 recorded each employee's status of today from his join
date; an employee whose status changed earlier this year would otherwise be
computed with the new status for the whole tax year. From `apps/api`, with the
migration owner's connection (`MIGRATION_DATABASE_URL`):

```sh
pnpm exec tsx src/db/backfill-ptkp-history.ts            # running tax year (Jakarta)
pnpm exec tsx src/db/backfill-ptkp-history.ts --year 2026 # an explicit year
```

For every employee with a locked or paid payslip in that year it writes the
status of his first payslip of the year on 1 January (or his join date), and,
when his status today differs, today's status from the deploy date (in force
from the next tax year). It is idempotent and prints counts only.

Apply migrations once per release. Both servers honor `PORT` and `HOST`. The API bundle (`apps/api/dist`) includes its dependencies; it needs only `dist/` (and `drizzle/` for migrations).

## Docker images

Build from the repository root. Each Dockerfile prunes the workspace with `turbo prune`, installs from the pruned lockfile, builds, and ships only the output:

```sh
docker build -f apps/api/Dockerfile -t my-api .
docker build -f apps/api/Dockerfile --target migrator -t my-api-migrate .
docker build -f apps/web/Dockerfile --build-arg VITE_API_URL=https://api.example.com -t my-web .
```

```sh
docker run --rm -e DATABASE_URL="$DATABASE_URL" my-api-migrate

docker run -d -p 4000:4000 \
  -e DEPLOYMENT_MODE=production \
  -e EDGE_MODE=false \
  -e DATA_CLASSIFICATION=real \
  -e DATABASE_URL="$DATABASE_URL" \
  -e BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" \
  -e STAFF_PIN_PEPPER="$STAFF_PIN_PEPPER" \
  -e BETTER_AUTH_URL=https://api.example.com \
  -e WEB_URL=https://app.example.com \
  -e COOKIE_DOMAIN=.example.com \
  -e TRUST_PROXY=1 \
  my-api

docker run -d -p 3000:3000 -e DEPLOYMENT_MODE=production -e EDGE_MODE=false \
  -e DATA_CLASSIFICATION=real -e API_INTERNAL_URL=http://api:4000 my-web
```

The builds need no secrets. Pass real values to running containers; never put secrets in `--build-arg`, `ENV`, or the image. `VITE_API_URL` is public by design. Rebuild the web image when the API's public origin changes.

Both images run as the unprivileged `node` user. Their `HEALTHCHECK`s report liveness only (`/api/health`, `/icon.svg`), so a database outage does not restart healthy processes. `GET /api/health/ready` additionally checks PostgreSQL for platforms that want a readiness probe. Both servers shut down gracefully on SIGTERM.

## Gerbang rilis 1

Gerbang rilis 1 menahan deploy ke database yang sudah berisi data bila data itu akan merusak migrasi baru, atau bila tabel migrasi tidak cocok dengan repo. Runner ada di `apps/api/src/db/release-gates.ts` dan dipanggil dari `predeploy-check` (lihat "Pre-deploy check"), sehingga `deploy/single-vm/deploy.sh` dan first boot `provision-roles.sh` ikut menahan. Runner hanya membaca: satu transaksi `READ ONLY` dengan `row_security=off`, selalu di-rollback.

Urutan yang dijalankan `predeploy-check`:

1. Cek migrator dan outbox yang sudah ada (legend-jtnd, legend-k1np).
2. **Cek drift migrasi** (legend-fgg1h). Tiap baris `drizzle.__drizzle_migrations` dicocokkan dengan journal repo (`apps/api/drizzle/meta/_journal.json`) lewat `created_at` = `when`, lalu hash-nya dibandingkan dengan sha256 berkas `.sql` repo (cara hash migrator drizzle). Hash beda atau `created_at` yang tidak dikenal journal berarti gagal. Entri journal yang `when`-nya lebih kecil dari `created_at` terbaru di database tetapi tidak punya baris di database juga gagal (`missing:<tag>`): drizzle hanya menjalankan entri yang lebih baru dari yang terakhir diterapkan, jadi entri itu tidak akan pernah dijalankan. Pengecualian hash hanya lewat daftar izin `scripts/preflight/drift-allow.json` (lihat di bawah).
3. **Berkas gerbang data.** Tiap `scripts/preflight/rilis1-*.sql` dijalankan berurutan menurut nama. Berkas lain di folder itu (mis. `0301-duplicate-subscriptions.sql`, `drift-allow.json`) tidak dibaca sebagai gerbang. Berkas gerbang dikirim ke PostgreSQL lewat protokol extended, jadi berkas berisi lebih dari satu statement gagal (pesan hanya memuat id gerbang). Header berkas: `gate`, `before` (tag journal atau `none`), `requires` (tabel), `mode` (`block` atau `info`), `resolve` (satu kalimat).

Cara menjalankan manual, di host deploy dengan env file yang sama dengan `deploy.sh`:

```sh
docker compose --env-file /absolute/path/compose.env -f deploy/single-vm/compose.yaml \
  --profile migration run --rm migrate node dist/predeploy-check.js
```

Image migrator memuat `scripts/preflight/` dan `apps/api/drizzle/` (journal dan berkas `.sql`). Path dapat ditimpa dengan env `LEGEND_PREFLIGHT_DIR` dan `LEGEND_MIGRATIONS_DIR`.

### Arti hasil

- **`gerbang data rilis 1: N/A (DB baru)`**: tabel `drizzle.__drizzle_migrations` belum ada atau kosong **dan** `to_regclass('public.tenants')` kosong. Ini database baru: cek drift dan semua gerbang data dilewati karena belum ada data yang bisa dirusak migrasi. Bukan kegagalan.
- **`tabel migrasi drizzle tidak ada/kosong padahal skema aplikasi ada`**: tabel migrasi hilang atau kosong, tetapi `public.tenants` ada. Riwayat migrasi hilang dari database yang berisi aplikasi, jadi N/A tidak berlaku dan deploy berhenti. Pulihkan tabel migrasi dari backup; jangan mengisinya dengan tangan.
- **`gerbang <id> dilewati (before-applied)`**: migrasi `before` berkas itu sudah tercatat di tabel migrasi (`created_at` = `when` tag itu). Data lama sudah melewati migrasi tersebut, jadi gerbang tidak relevan lagi. Runner mencatat `gerbang <id> dilewati (before-applied)`.
- **`gerbang <id> dilewati (requires-missing)`**: salah satu tabel di `requires` belum ada. Tidak ada data di tabel itu yang bisa melanggar. Runner mencatat `gerbang <id> dilewati (requires-missing)`.
- **`gerbang <id> (info): N baris`**: mode `info` hanya mencetak jumlah (untuk `legend-oh2a5`, N = jumlah tenant). Tidak menahan deploy. Catat angkanya sebagai bukti rilis.
- **Baris sukses CLI** (`apps/api/src/predeploy-check.ts`): `Pre-deploy check passed: migrator <user> (<superuser|BYPASSRLS>), outbox <N rows, per-destination sequences intact|absent>, <release gates ok (<A> migrations applied, <R> gate(s) run, <S> skipped)|release gates N/A (new database)>.` Contoh: `Pre-deploy check passed: migrator legend_migrator (BYPASSRLS), outbox absent, release gates ok (700 migrations applied, 2 gate(s) run, 1 skipped).` Kegagalan: `Pre-deploy check failed: <pesan>` dan exit code 1.
- **`gerbang data rilis 1 gagal: legend-x (3 baris), legend-y (1 baris)`**: mode `block` menemukan baris. Deploy berhenti sebelum migrasi apa pun, dan layanan tidak dinyalakan.
- **`drift migrasi (legend-fgg1h): <tag>, ...`**: hash berkas repo berbeda dengan yang tercatat di database, atau ada migrasi di database yang tidak dikenal repo (`unknown@<created_at>`), atau entri journal lama yang tidak pernah diterapkan (`missing:<tag>`). Hash beda yang cocok persis dengan entri `drift-allow.json` tidak gagal dan dicatat `drift diizinkan: <tag> (<bead>)`.

Fail-closed: `drift-allow.json` yang hilang (saat gerbang berjalan, bukan N/A), bukan JSON, berbentuk salah, bertag yang tidak ada di journal, atau berhash bukan 64 hex; header berkas yang rusak atau urutannya salah, `mode` tidak sah, tag `before` yang tidak ada di journal, journal dengan `when` ganda, dan error SQL di berkas gerbang semuanya menggagalkan pre-deploy check. Tidak ada yang dilewati diam-diam. Pesan tidak pernah memuat URL, password, tenant id, atau isi baris; hanya id gerbang, jumlah, dan tag migrasi. Bukti rinci diambil operator dengan menjalankan SQL berkas itu sendiri memakai login yang melihat semua tenant (superuser atau `BYPASSRLS`, `row_security=off`), dan jangan ditempel di log publik.

### Resolusi per gerbang

Bila gerbang menahan rilis, selesaikan penyebabnya, jalankan ulang pre-deploy check, dan lanjut hanya bila hasilnya bersih. Jangan melewati gerbang dengan menghapus baris migrasi, mengedit berkas gerbang, atau menurunkan `mode`.

| Gerbang                                         | Kartu           | Penyebab                                                                                                                                                                                                                                                                                                                                                                      | Resolusi                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drift migrasi, 0239 lama                        | legend-fgg1h    | Berkas 0239 diedit di tempat (ps-405). Bila ada database bersama (staging atau production) yang sudah menerapkan versi lamanya, hash-nya tidak cocok.                                                                                                                                                                                                                         | Jangan menyunting berkas 0239 untuk mencocokkan hash. Tulis migrasi koreksi baru yang membawa database itu ke keadaan yang diharapkan, di-review architect. Lalu tambahkan hash lama yang persis ke `scripts/preflight/drift-allow.json` dengan id bead (keputusan CTO atau founder, lewat PR yang di-review). Butuh akses dan persetujuan founder lewat CTO. |
| Drift migrasi, 0674 versi sebelum koreksi tiw2h | legend-tiw2h    | 0674 versi sebelum koreksi tiw2h (bila sebuah database bersama sempat menerapkannya): hash-nya tidak cocok dengan berkas repo.                                                                                                                                                                                                                                                | Migrasi koreksi baru yang di-review architect; jangan edit berkas lama. Lalu tambahkan hash lama yang persis ke `drift-allow.json` dengan id bead (keputusan CTO atau founder, PR yang di-review).                                                                                                                                                            |
| `legend-176r3`                                  | legend-176r3    | Tenant aktif punya klien MCP approved atau token MCP aktif, tetapi paketnya tanpa fitur `mcp`. Baris paket yang tidak ada juga dihitung, dan menahan rilis walau `feature_flags` tenant itu sudah berisi `mcp` (konservatif, sesuai brief). Migrasi `0456_mcp_flag_backfill` hanya menyalakan flag untuk paket yang memuat `mcp`, jadi tenant itu kehilangan MCP saat deploy. | Beri tahu founder lewat CTO. Ubah paket tenant agar memuat `mcp`, atau putuskan tenant itu memang kehilangan MCP dan cabut klien dan token-nya. Pre-launch biasanya nol baris.                                                                                                                                                                                |
| `legend-oh2a5`                                  | legend-oh2a5    | Mode `info`: jumlah tenant yang akan dinyalakan `0378_ai_assistant_auto_enable` (paket aktif memuat AI dan ada riwayat penggunaan AI).                                                                                                                                                                                                                                        | Tidak menahan rilis. Catat jumlahnya, lalu pastikan founder tahu berapa tenant yang akan mendapat asisten AI menyala otomatis.                                                                                                                                                                                                                                |
| Gerbang cabang 1097 (payout dan rekon) dan 1098 | lihat berkasnya | Gate dari cabang `ws/1097` dan `ws/1098`, bila sudah digabung. Umumnya data payout atau bukti historis yang membuat migrasi RAISE atau backfill macet.                                                                                                                                                                                                                        | Baca baris `-- resolve:` di `scripts/preflight/rilis1-legend-<id>.sql`; berkas belum ada = gate belum aktif. Menyangkut uang: jangan hapus atau ubah baris payout untuk meloloskan gerbang; bawa keputusannya ke founder lewat CTO.                                                                                                                           |

### Daftar izin drift

`scripts/preflight/drift-allow.json` (default `[]`) mengizinkan hash lama yang diketahui, satu entri per hash:

```json
[
  {
    "tag": "<tag journal>",
    "hash": "<64 hex hash lama>",
    "bead": "legend-xxx",
    "reason": "<alasan>"
  }
]
```

Baris database dengan `created_at` = `when` tag itu dan `hash` sama persis dengan entri diterima dan dicatat `drift diizinkan: <tag> (<bead>)`. Tidak ada wildcard; hash lain tetap gagal. Daftar ini tidak menutupi `unknown@<created_at>` maupun `missing:<tag>`. Menambah entri adalah keputusan CTO atau founder lewat PR yang di-review, setelah migrasi koreksinya di-review architect. Opsi runner: `driftAllowFile` mengganti path berkas.

Gerbang baru ditambah dengan berkas `scripts/preflight/rilis1-legend-<id>.sql` saja, tanpa mengubah runner. Format header (parser `parsePreflightFile` di `release-gates.ts`), tepat lima baris pertama berurutan, lalu satu `SELECT` read-only (tanpa meta psql `\`):

```sql
-- gate: legend-<id>
-- before: <tag journal atau none>
-- requires: public.<tabel>[, public.<tabel>]
-- mode: block
-- resolve: <satu kalimat>
SELECT count(*) FROM public.<tabel> WHERE ...;
```

Nama tabel di `requires` selalu `public.<tabel>`; di SQL jangan menulis nama skema pada nama tabel (runner mengatur `search_path`). Migrasi baru harus punya `when` di journal yang lebih besar dari entri sebelumnya (legend-ir8n8; entri 0003 pengecualian lama); cek ganda dan urutan ada di `apps/api/src/test/migration-journal.test.ts`. Test `apps/api/src/test/migration-journal.test.ts` memvalidasi tiap berkas (header sah, tag `before` ada di journal, tabel `requires` ada di skema) supaya berkas yang salah tertangkap sebelum rilis.

Urutan rilis edge dan cloud untuk rilis pertama dan upgrade berikutnya ada di `docs/runbooks/rilis1-urutan-edge-cloud.md`.

## Logs in production

Both servers write one JSON object per line to stdout with `level`, `time`, `service` (`api`/`web`), `env`, `msg`, and `reqId` (plus `userId` on authenticated API requests). Ship stdout to your log platform; correlate a page render across services by `reqId`. Forward an `X-Request-Id` from your load balancer and both servers reuse it. `LOG_LEVEL` adjusts verbosity; `LOG_SQL=true` is for debugging only.

## Connection pooling and scaling

The API uses one node-postgres pool with at most ten connections per process. Multiple instances multiply the connection count: use your provider's pooler and tune limits. Better Auth's rate-limit storage is in memory per instance; for several API instances configure shared rate-limit storage (see Better Auth's rate-limit docs). The web server keeps no state.

## Object storage settings

One set only: `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY`, `STORAGE_S3_PRIVATE_BUCKET`, `STORAGE_S3_PUBLIC_BUCKET`, `STORAGE_PUBLIC_BASE_URL` (https) and `STORAGE_S3_REGION` are required together (no silent default region: a wrong region breaks uploads); `STORAGE_S3_ENDPOINT` and `STORAGE_S3_FORCE_PATH_STYLE` are optional. Uploads, HRIS files and profit share statement PDFs all read this set. The older `OBJECT_STORAGE_*` names are a deprecated fallback: the API warns once at startup, and refuses to start if a legacy key and its `STORAGE_S3_*` counterpart hold different values. `pnpm run doctor` reports a partial set or a conflict. Fill `STORAGE_S3_*` only.

## Object storage permissions

Payout payment proofs are checked with a read of the object before resolve, return, confirm or an overpaid record. On S3-compatible storage the API key must hold `s3:ListBucket` on the private bucket as well as `s3:GetObject` and `s3:PutObject`. Without `ListBucket`, a missing object answers AccessDenied instead of NoSuchKey, and a key that was never uploaded then fails with a 500 instead of 422 `PAYOUT_EVIDENCE_INVALID`. No payment is recorded either way.

## Pemindai malware (ClamAV) (legend-w9hwh)

API memindai unggahan lewat `clamd`. Gambar dipindai bila `clamd` ada. Bila `clamd` mati, gambar tetap diterima karena sharp meng-encode ulang pikselnya. PDF wajib lolos `clamd`. Tanpa `clamd`, PDF dijawab 503 `SERVICE_UNAVAILABLE`.

**Service.** Jalankan `clamav/clamav` di VPS, dengan tag LTS yang berlaku saat deploy (patok tag, jangan `latest`). Taruh di jaringan Docker internal saja. Port 3310 tidak dibuka ke internet. Ini perkecualian aturan "Docker hanya untuk database dan Redis", yang berlaku untuk Mac dev, bukan VPS.

**Batas.**

- `mem_limit: 1536m` pada container (`deploy/single-vm/compose.yaml`, service `clamav`, image `clamav/clamav:1.4.7`, volume `clamav_db`). `CLAMD_HOST=clamav` dan `CLAMD_PORT=3310` sudah diisi di service `api` pada compose. Dengan ClamAV, VM minimal 4 GB RAM (postgres 768m, api 512m, web 512m, worker 384m, caddy 128m, clamav 1536m, ditambah sistem dan job migrate/provision-roles 512m masing-masing saat berjalan).
- `clamd.conf` (`deploy/clamav/clamd.conf`, dipasang read-only oleh compose): `ConcurrentDatabaseReload no`, `AlertExceedsMax yes`, `MaxFileSize 100M`, `MaxScanSize 200M`, `StreamMaxLength 12M`.
- `AlertExceedsMax yes` wajib: tanpa itu, berkas di atas batas dijawab `stream: OK` tanpa dipindai. Dengan opsi ini berkas di atas `MaxFileSize` atau `MaxScanSize` dijawab `FOUND` (422, ditolak). Berkas di atas `StreamMaxLength` dijawab `ERROR` oleh clamd, yang menjadi 503 `SCANNER_UNAVAILABLE` (bukan `FOUND`).
- Dengan `ConcurrentDatabaseReload no`, pemindaian tertahan beberapa puluh detik saat reload signature harian. PDF yang masuk saat itu dijawab 503 dan bisa dicoba lagi.

**Signature.** `freshclam` bawaan image butuh akses keluar ke `database.clamav.net`.

**Env API.**

```bash
CLAMD_HOST=clamav          # nama service di jaringan internal; kosong = tanpa pemindai
CLAMD_PORT=3310            # bawaan 3310
CLAMD_TIMEOUT_MS=15000     # bawaan 15000 (1000 sampai 60000)
```

**Cek.** `GET /api/health` menjawab `{ "status": "ok", "scanner": "ok" | "unavailable" | "disabled" }`. Status HTTP tetap 200 apa pun nilai `scanner`. `disabled` berarti `CLAMD_HOST` kosong. `unavailable` berarti PING ke `clamd` gagal (hasil di-cache 30 detik). Pastikan `scanner` bernilai `ok` setelah deploy.

**Cadangan.** Bila RAM VPS tidak cukup, biarkan `CLAMD_HOST` kosong. PDF tetap 503 dan finance mengunggah foto atau screenshot.

## Public API rate limits

The API's session-free reads — the guest QR scan and menu (`/api/qr/*`), the brand website and its menu (`/api/public/site/*`), the SSR brand context (`/api/tenant/*`) and customer payment links (`/api/payments/links/*`) — are capped by one in-memory limiter in the API. Authenticated routes are bounded by their session and permissions; these have no session at all, and the menu reads return the whole catalogue.

Two fixed one-minute windows are charged on every public read: one per client IP and one per resolved tenant. A request over either limit answers `429` with `{"error":{"code":"RATE_LIMITED"}}`, a `Retry-After` header holding the whole seconds left in the window, and `Cache-Control: no-store`. Health, Better Auth (`/api/auth/*`), provider webhooks and the TLS ask are not mounted on the limiter.

| Variable                                    | Default  | Meaning                                                                                                                                                    |
| ------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_RATE_LIMIT_PER_MINUTE`              | `600`    | Requests per client IP per minute                                                                                                                          |
| `PUBLIC_RATE_LIMIT_TENANT_PER_MINUTE`       | `6000`   | Requests per resolved tenant per minute                                                                                                                    |
| `PUBLIC_RATE_LIMIT_INTERNAL_IPS`            | loopback | Web server address(es) that skip the per-IP bucket (comma-separated)                                                                                       |
| `REDIS_URL`                                 | unset    | Optional. Shares the public rate-limit windows across API instances (see below). Unset = in-memory per process, no Redis needed                            |
| `SSR_SHARED_SECRET` (API **and** web)       | unset    | Optional, min 32 chars, same value on both. Lets the API trust the visitor IP the web server forwards (see below)                                          |
| `WEB_TRUST_PROXY_HOPS` (web)                | `2`      | Proxies in front of the web server (Cloudflare + Caddy = 2). Picks the visitor IP from `X-Forwarded-For` counting from the right                           |
| `PUBLIC_RATE_LIMIT_GUEST_TENANT_PER_MINUTE` | `60000`  | QR guest table-session requests per tenant per minute (own bucket; guests also get 10x the per-IP budget for a venue NAT and 600/min per table credential) |

Sizing the defaults — they must not break legitimate traffic:

- Guests on the venue Wi-Fi usually reach the API through **one NAT address**, so all their scans, menu reads and payment polls share one IP bucket. Payment status polls every 2 s while a payment is pending (30 requests a minute per guest).
- The web server's **SSR fetches** (website pages, the brand context on every render) come from one address — the web server's — and carry no visitor IP. That address skips the per-IP bucket and only counts against the tenant bucket: list it in `PUBLIC_RATE_LIMIT_INTERNAL_IPS` (loopback by default, for web and API on one VM; add the web container's address under Docker). Without it every visitor would share one 600/min bucket.
- Authenticated payment admin (`/api/payments/admin/*`) is not on the limiter: staff at the venue share the guests' NAT address.
- The in-memory store is bounded (20 000 keys per bucket, least recently used evicted first) and lives per API process. Without `REDIS_URL`, N API instances allow up to N times the configured limit; the Cloudflare rule below is the shared edge layer. With `REDIS_URL` set, the public per-IP, per-tenant, guest-session and booking-request windows are counted in Redis (`rl:<bucket>:<key>:<window>` keys that expire with the window), so all instances share one limit. Each limiter has its own bucket namespace so their budgets never mix: `public:ip`, `public:tenant`, `guest:ip`, `guest:tenant`, `guest:session`, `guest:cred-ip`, `booking:ip`, `booking:tenant`. Guest table-session routes check IP and tenant first and create the per-credential key only afterwards, for a well-formed bearer (stored as a SHA-256 digest); The new keys one IP can create per minute are bounded by `guest:ip` (the guest per-IP limit); the optional `perIpCredentials` option adds a tighter `guest:cred-ip` cap and is off by default (no extra Redis call). Because IP and tenant are checked first, a table that keeps retrying after its own session 429 still spends the venue's shared `guest:ip` and `guest:tenant` budget; it takes about 100 requests a second from one table to reach the default guest limit of 6000 a minute per IP. If Redis is down or slower than 200 ms the request is counted in the process-local window instead (fail open per instance, never a 5xx). A single-VM deploy needs no Redis and loads no Redis client.

### Visitor IP from SSR (legend-moe5)

By default the web server's SSR calls carry no visitor IP, so its address skips the per-IP bucket and SSR reads are capped only per tenant. Set the **same** `SSR_SHARED_SECRET` (min 32 characters, generate with `openssl rand -hex 32`) on the API and the web server to close that gap: the web server forwards the visitor address (`x-starter-visitor-ip`) with the secret (`x-starter-ssr-auth`), and the API charges the per-IP bucket with it. The API accepts the address only when the secret matches (constant-time compare); both headers are always stripped from the request, so a browser that sends them gets no effect. Without the secret the API ignores them and behaves as before.

- `WEB_TRUST_PROXY_HOPS` must match the proxies in front of the **web** server (default `2` = Cloudflare + Caddy). Too low and every visitor behind one Cloudflare edge shares a bucket; if the chain is shorter than the count, the header is omitted and the old behaviour applies.
- A page render makes several SSR calls, all charged to the visitor's per-IP bucket (shared with their own browser calls). Keep `PUBLIC_RATE_LIMIT_PER_MINUTE` well above that.
- **Origin firewall:** with `TRUST_PROXY=2` a client that reaches the origin directly (bypassing Cloudflare) can choose its own `req.ip`. The origin must accept only Cloudflare's published IP ranges (and the web container), or per-IP limits can be dodged by spoofing `X-Forwarded-For`.

`TRUST_PROXY` decides which address is "the client": the limiter uses `req.ip` as Express resolved it, never a raw `X-Forwarded-For`. Behind Cloudflare in front of Caddy that is **two** hops (`TRUST_PROXY=2`); with a single reverse proxy it is `1`. If the hop count is too low, every client appears as the proxy's address and all of them share one bucket.

### Edge bootstrap limits

The edge bootstrap routes (`/api/edge-sync/bootstrap/*`) have their own in-memory limiter, mounted before tenant resolution so a flood is refused before any database query. `/masters` (the master sync every edge node polls) has its own buckets: 120 requests per minute per IP and 30 per IP and credential (the bearer, hashed). The other bootstrap routes allow 30 per IP and 10 per credential.

- An outlet's edge nodes share the outlet's public IP. A guest device on the same network can use up the per-IP budget and delay that outlet's sync for the rest of the minute. Keep edge nodes on a network segment guests cannot use, or put the outlet behind its own address.
- `TRUST_PROXY` must match the proxy hops here too: with too few hops every edge node in the fleet appears as the proxy's address and they all share one per-IP bucket.

### Cloudflare free-plan rule (edge layer)

The API limiter is one process's backstop. Put a stricter, shared rule at the edge where the plan allows it. On the **Free plan** Cloudflare's rate limiting rules allow **one rule**, a **10-second counting period**, **IP-only** counting, a **10-second mitigation timeout**, and expressions limited to **path** (plus verified bot). One rule can still cover the two catalogue-dumping surfaces:

- Field: `http.request.uri.path`, match `contains "/api/qr/"` **or** `contains "/api/public/site/"` (a single custom expression). The other two prefixes keep the API limiter only; payment links carry a 256-bit token and are polled during checkout, the brand context is one read per page.
- Requests: `30` per `10 seconds` per IP — 180 a minute, below the API's 600 default, so the edge sees an abuser first.
- Action: **Managed Challenge**, so a real guest recovers by solving one page instead of waiting for the block to lift. Use **Block** with the 10-second mitigation period only if the venue never needs to scrape its own menu.

On Pro and above, split the paths into separate rules with a longer period and a block action. Keep the API limits at or above the edge limits, so a legitimate client never meets the API's 429 before the edge rule has had its chance to challenge it.

## Public HTML cache (legend-vz93)

By default every web response is `Cache-Control: private, no-store`, because SSR pages embed the visitor's session. Exactly one case is cacheable by a shared cache (Cloudflare): an anonymous `GET`/`HEAD` of **`/`** or **`/menu`** that answers `200`, carries **no `Cookie` header at all**, and sets no `Set-Cookie`. It is sent as `public, max-age=0, s-maxage=60, stale-while-revalidate=300` with `Vary: Host` (merged with any `Vary` the route set). Every other page, any signed-in or cookie-bearing request, errors and redirects stay `private, no-store`. A route that sets its own `Cache-Control` keeps it. Without a cookie the session is null, so the cacheable HTML is the anonymous page only.

| Variable (web)              | Default | Meaning                                                                          |
| --------------------------- | ------- | -------------------------------------------------------------------------------- |
| `PUBLIC_HTML_CACHE_SECONDS` | `60`    | Shared-cache lifetime (`s-maxage`) in seconds. `0` turns public HTML caching off |

Cloudflare setup (the origin only declares what is safe; the CDN rule still has to be correct):

- The cache key **must include the hostname** (the default Cloudflare key does), so each tenant domain has its own entry. Never use a rule that ignores the host.
- **Bypass the cache when a `Cookie` request header is present** (Cache Rule: `http.cookie ne ""` → bypass), so a signed-in visitor is never served the anonymous copy. Do not add a cache-everything rule for other paths.
- The page is not purged when a menu changes: staff see the change after at most `s-maxage` plus the stale window (about 6 minutes). Purge on menu change is not built.
- Before enabling the rule, check with two hostnames and a signed-in cookie that each gets its own page and that the cookie request shows `cf-cache-status: BYPASS`.

## Staff device PIN down-sync runbook

The cloud sends staff PIN changes to each outlet's edge in commit order, using `staff_pins.sync_xid` (migration `0151_staff_pin_sync_xid`). Follow these rules when you operate the cloud database or release the API.

1. **Durability.** The cloud database must run with `synchronous_commit = on` and `fsync = on`. A commit that was exported but then lost in a crash could have its transaction id reused, and the edge would skip the change. Do not turn either setting off, even for load tests.
2. **Dump and restore.** After a dump/restore into a new cluster, restamp `sync_xid` on every `staff_pins` row. Run it as the migration owner, the same way as migration `0141_great_firedrake`: lift `FORCE ROW LEVEL SECURITY` for the statement, touch every row, then force it again. Example: `UPDATE "staff_pins" SET "sync_xid" = pg_current_xact_id()`. Point-in-time recovery, promotion, and restart need no action: a new epoch makes each edge do one idempotent full resync per outlet.
3. **Idle transactions (legend-4z2ch, legend-9h0kg).** One transaction that stays open and idle holds `pg_snapshot_xmin` back, so PIN and catalog sync stop for every outlet until it ends. `provision-roles.sh` sets `idle_in_transaction_session_timeout = '5min'` on the application login (`legend_runtime_*`) and the queue login (`legend_worker_*`) on every run, right after its `ALTER ROLE ... RESET ALL` (`apps/api/src/db/provision-roles.ts`), so the reset cannot remove it. Roles created before this release get it on the next run of the job. The job checks the value is exactly `5min` after setting it, and any other role-level setting on these logins fails the run. The migration login and the maintenance login are not changed, and the maintenance login may carry no role-level setting at all (the audit fails if it has this one). Do not set it by hand on those roles: the next run resets it. A role setting applies only to new sessions: after the job runs, restart the API and worker (or reconnect their pooled connections) so sessions that are already open pick up the timeout. For other logins, such as an operator's `psql` session or a BI tool, set it with `ALTER DATABASE ... SET idle_in_transaction_session_timeout = '5min'`, which survives the reset. Alert when the oldest open transaction that holds an id, or the oldest prepared transaction, is older than 10 minutes, which is the age of `pg_snapshot_xmin`. The age counts from `xact_start`, which can over-estimate (a transaction may get its id later); that only alerts earlier. The probe login must be a superuser or a member of `pg_read_all_stats`, otherwise the probe fails instead of reporting 0. `deploy/monitoring/check.mjs` does this when `MONITOR_XMIN_ENABLED=true` (see `deploy/monitoring/README.md`). The alert is named `xmin_age`; when it fires, find the session with `SELECT pid, usename, state, xact_start FROM pg_stat_activity WHERE backend_xid IS NOT NULL ORDER BY xact_start` and end it with `pg_terminate_backend(pid)`. A long open write transaction delays the export for every tenant. It never loses changes.
4. **Cloud database restore and catalog sync (legend-y9y8y).** The catalog down-sync cursor holds a `sync_txid`. The cloud refuses a cursor whose txid is above its current `pg_snapshot_xmax` (HTTP 400, header `X-Edge-Error: CATALOG_CURSOR_REJECTED`), and the edge then pulls that stream again from the start by itself. This catches only a restore that left the transaction counter below the edge's cursor. A restore (PITR, snapshot) whose counter has already passed the cursor is not detected: the edge keeps its checkpoint and skips rows written under reused txids. After a dump/restore, do both steps below, in this order. Run each as the migration owner, lift `FORCE ROW LEVEL SECURITY` on the tables for the transaction, and force it again before commit, the way migration `0375_recipes_resync_edges` does.
   - Cloud, restamp. Restored catalog rows keep their old `sync_txid`, which may lie above the new cluster's counter and stay invisible to the export (`sync_txid < pg_snapshot_xmin`) until the counter passes it. Touch every row of the catalog tables with the stamp trigger switched off, so the value written is kept: `BEGIN; ALTER TABLE ... NO FORCE ROW LEVEL SECURITY; SELECT set_config('legend.skip_sync_txid', 'on', true); UPDATE <table> SET sync_txid = pg_current_xact_id()::text::bigint; ALTER TABLE ... FORCE ROW LEVEL SECURITY; COMMIT;`. The tables are `stations`, `edge_printers`, `edge_printer_tombstones`, `inventory_items`, `recipes`, `menu_categories`, `modifier_groups`, `modifiers`, `menu_items`, `item_variants`, `menu_item_modifier_groups`, `price_lists`, `promotions`, `vouchers`, `promo_settings`. `apps/api/src/test/edge-catalog-restamp-list.test.ts` fails when a table with a `sync_txid` column is missing from this list. Do not use `SET updated_at = updated_at` here: the `promotions` and `edge_printers` triggers ignore a change that touches no rule or registry column. Restamp before the edges reconnect (keep the edge APIs stopped, or the cloud unreachable for them, until it is committed). While a row of a stream still carries a stamp at or above the cloud's horizon, the cloud's pages carry no snapshot fields, so the edges deactivate nothing for that stream; they only resume deactivating once the restamp is committed (legend-7r7q6).
   - Each edge database, rewind. First stop the edge API and start it again after the statements below (legend-1212: a running edge keeps its last promo gate reading for up to 60 seconds, so a promo the restored cloud no longer has could still discount in that minute; a restart starts with promos closed). A pull in progress keeps the mark you set (later pages do not overwrite it). Then set the watermark of the catalog checkpoints to the rewind mark, so the next pull reads every stream from the start (idempotent): `UPDATE edge_pull_checkpoints SET watermark = 'rewind' WHERE stream IN ('catalog:stations', 'catalog:printers', 'catalog:inventory_items', 'catalog:recipes', 'catalog:menu_categories', 'catalog:modifier_groups', 'catalog:modifiers', 'catalog:menu_items', 'catalog:item_variants', 'catalog:menu_item_modifier_groups', 'catalog:price_lists', 'catalog:promotions', 'catalog:vouchers')`. Right after it, close promos and vouchers at once (legend-1212): `UPDATE edge_pull_checkpoints SET last_success_at = 'epoch' WHERE stream IN ('catalog:promotions', 'catalog:vouchers')`. The promo gate also reads the rewind mark and the `catalog:replay:promotions` marker, so promos and vouchers stay off (sales at the normal price, never blocked) from the rewind until the replay is confirmed, even when the cloud cannot be reached; they return after the pull that clears the marker. Do not delete rows from `edge_pull_checkpoints`: `last_success_at` keeps the 24 h freshness gate from blocking sales (other streams keep their time), and the `catalog:init:*`, `catalog:schema-*`, `:parents` and `:fallbacks` rows are state of their own, not cursors. Use `'rewind'`, not `NULL` (legend-7r7q6): the mark makes the edge raise a per-node receipt floor in `catalog:receipt-floor`, so link receipts from before the restore (an old high version) stop holding the catalog on the old value; the restored cloud values, and later changes over HTTP or the link, are applied. A stored cursor the cloud refuses (ahead of the restored cloud) is treated the same way. Receipts after the floor protect as usual, so an older HTTP replay never overwrites a newer link event. A cleared (`NULL`) watermark alone still restores values but the edge cannot tell it from a first boot, so it does not release the old receipts. Do not edit `catalog:receipt-floor` or `catalog:replay:*` rows by hand (an unreadable floor value is ignored, which means no floor). The floor is per edge node, not per stream: rewinding one stream also releases old receipts of the other streams of that node for their next full replay; rewind all streams together as in the statement above. The rewind also sets `catalog:replay:<stream>`. Items the restored cloud no longer has are deactivated on the edge (`is_active = false`, or `deleted_at` where the table has no flag; promotions stop applying); they are never deleted, so an offline sale that references them stays valid. This takes two steps, because the cloud only exports rows below its snapshot `xmin`: when the replay reaches its last page the edge pins the cloud's snapshot horizon in the marker, and the deactivation happens on a later pull whose last page reports that every row up to that horizon is visible. Until then nothing is hidden. Absence is concluded only from that complete replay, never from one incremental page; a replay that stops early, or a cloud older than this protocol (its pages carry no snapshot fields), keeps the marker and deactivates nothing. A stream that is empty in the restored cloud (a backup taken before the first promotion, for example) still confirms: the cloud gives an edge on this release a start cursor for the empty first page, so the next pull is incremental and its items are deactivated. The deactivation is per tenant on the edge database, which assumes one edge node (one outlet) per edge database. Menu and price changes still waiting in the cloud's own publish queue are restored with the cloud and are not changed by this step.
5. **Release order.** Release the cloud (API and database migrations) before the edge.
6. **One machine per edge node (legend-rucdm).** The cloud adopts a node's later PIN set by that node's event sequence, so two machines must never send under one edge node id. The standby keeps its own credential: never start it from a copy of the primary's credential or disk. A node restored from a backup or snapshot may run only after the old machine can no longer reach the cloud. An edge database rebuilt from empty under the same node id gets a new `edge_nodes.instance_id` and restarts its link and event sequences. An edge on this release sends that instance on the link, and the cloud then resumes the node by itself (legend-o839h, legend-nd3cu). The cloud rebases the node's link cursors onto the new database. Events the old database already delivered are not replayed, and cloud events still pending are delivered. The cloud orders the new database's PIN sets by their set time. Release order: cloud first (migration `0162_sync_cursor_peer_instance`), then the edges. Enroll a rebuilt edge as a new node instead in three cases. First, the edge runs an older release that does not send its instance. Second, the rebuild happens together with the first upgrade to this release. Third, the database is a restored or cloned copy. Never put a restored or cloned edge database back into service under the same node. A restore or clone keeps the same `instance_id`, so the cloud sees no instance change. Once a node is bound to an instance, the cloud also refuses a link without an instance, such as a downgrade to an older edge release.

   Restored or cloned database (legend-a9iby). The cloud refuses the link with close 1008 when the edge's hello cursor is below what the cloud already saw it acknowledge. The hello cursor is the highest `cloud_to_edge` link sequence the edge applied without a gap. The cloud writes nothing and acknowledges nothing. The close reason reads `Edge database is older than the cloud's link cursor (restored or cloned); refusing to resume`. The edge keeps retrying with backoff, and the cloud refuses it each time, because 1008 is not final on the client. The edge database must also run with `synchronous_commit = on` and `fsync = on`. An edge that loses an applied and acknowledged batch in a power cut looks the same as a restore, and the cloud refuses it the same way.

   The cursor check above detects a restore only when the edge had acknowledged `cloud_to_edge` events newer than the backup. Today only QR orders produce them (`apps/api/src/edge/qr-order-forwarding.ts`).

   Restore proof (legend-tmar2). An outlet without QR orders, or with none since the backup, has no such events, so its restored database used to resume and mark events it created under link numbers the cloud already received as acknowledged without sending them. An edge on this release now sends the header `x-edge-restore-proof` with its acknowledged outbound cursor A on every connect. When the cloud's received cursor N is above A, the cloud adds `inboundProof` (`from`, `count`, SHA-256 over the event ids of every `edge_to_cloud` link slot in (A, N], in slot order) to its hello. Before acknowledging N, the edge recomputes the same digest from its own outbound queue. A different id, a missing row or a different count refuses the link with close 1008 and a reason that starts with `Restore proof`. Nothing is acknowledged, and an unsent event, such as a panic alert, stays pending. The edge backs off between retries and never resets its backoff on this refusal.

   Release order: cloud first, then the edges. Full protection needs both sides on the 854 release. An older edge sends no header and gets the old hello. An edge on 854 or later against an older cloud (848 or earlier) gets no proof and no echo of `x-edge-restore-proof-v2`: when its hello cursor is above its acknowledged cursor, the edge refuses to resume (close 1008, reason `Restore proof unsupported: cloud does not support restore proof; upgrade cloud first`), acknowledges nothing, and stays on its reconnect backoff. It stays connected as before when the hello cursor is not above the acknowledged cursor. An older edge (848 or earlier) against a 854 cloud keeps the older behaviour: a proof only when it covers the whole range, and a restore at an outlet without newer QR orders is not detected for a longer range.

   Fail-closed proof (legend-tmar2, 854). An edge on this release sends a second header, `x-edge-restore-proof-v2: 1`, next to `x-edge-restore-proof`. For such an edge the cloud no longer omits the proof when it cannot cover the whole range. It proves the longest complete prefix of (A, N], at most 20000 slots, where each slot has exactly one receipt. When that prefix stops before N (a range longer than 20000 slots, a slot with no receipt, or a slot with more than one receipt), the proof also carries `to`, the last slot it covers, and may be empty (`to` = A, count 0). The hello omits `to` when the proof covers all of (A, N]. The edge checks the proof up to `to`, acknowledges only up to `to`, and sends (`to`, N] again. An edge from the previous release (848) sends only the first header. For it the cloud behaves as in 848: it sends a proof only when it covers all of (A, N], otherwise the hello carries no proof (the link resumes as before, no restore protection for that range), and it never sends `to`. An 848 edge therefore keeps working unchanged and is not looped by a refusal it cannot back off from. A refusal by the cloud (a replayed slot holding another event) also keeps the 854 edge on its reconnect backoff. The cloud 854 answers the upgrade with the header `x-edge-restore-proof-v2: 1` when the request carried it. When the cloud's hello cursor is above the edge's acknowledged cursor and the hello carries no proof, a 854 edge that read no such header from its cloud, or that got a hello without proof from a cloud that echoed it, refuses to acknowledge (reason starts with `Restore proof`) and keeps its backoff.

   Replayed batches. For an edge that sent `x-edge-restore-proof-v2` (854 only, not an 848 edge), the cloud checks every slot of a batch that is at or below its received cursor against its receipts before acknowledging the batch. A slot with the same event passes. A slot with no receipt whose event the cloud already holds gets a `superseded` receipt. A slot that holds a different event, or an event the cloud never received, refuses the link with close 1008 and a reason that starts with `Restore proof`, and nothing in that batch is acknowledged. A partial proof closes receipt holes this way: the edge sends the slots after `to` again and the cloud settles them. Each reconnect with N above A still scans the receipts of that node, because `edge_inbound_events` has no index on `link_seq`.

   If the edge log shows the warning `Edge link refused by protocol` with code 1008 and either restore reason (`Edge database is older ...` or `Restore proof ...`):

   - Stop that edge.
   - Keep its database for audit.
   - Enroll a new node, or rebuild the edge from empty so it gets a new instance.
   - Reconcile by hand any events that exist only on the restored database, from its outbound queue.

## Staff PIN pepper on edge nodes (legend-ideif)

The root `STAFF_PIN_PEPPER` lives only on the cloud. An edge node never holds it: the API refuses to start with `EDGE_MODE=true` and `STAFF_PIN_PEPPER` set (the log names the key, never the value). The cloud derives one pepper per tenant and pepper version (HKDF) and sends an edge only its own tenant's peppers, inside the staff PIN sync (`GET /api/edge-sync/staff-pin-records?peppers=<highest version held>`, TLS, `Cache-Control: private, no-store`). The edge seals them (AES-256-GCM, key derived from the node credential) in its table `edge_staff_pin_peppers` (migration `0225`). A stolen edge box therefore weakens one tenant, never the others.

1. **Release order.** Cloud first (it must know the `peppers` query), then the edges. An edge on this release against an older cloud gets HTTP 400 for `peppers`, falls back to the older query, and never receives a pepper, so it cannot verify PINs. Check the cloud version before you touch an edge.
2. **Upgrade an installed edge.** Do this with the outlet online:
   - Deploy the cloud, then run migration `0225` on the edge database.
   - Remove `STAFF_PIN_PEPPER` from the edge environment (secret store, compose file, systemd unit) and restart the edge. With the variable still set, the edge refuses to start.
   - Within one sync interval the edge logs `Edge staff pin peppers updated`. Until then PIN checks on the edge fail closed (the PIN is refused, no attempt is counted against the staff member). Do not take the outlet offline in that window.
3. **Rotate the pepper.** Set `STAFF_PIN_PEPPER_CURRENT_VERSION` on the cloud to the next number (for example `2`) and restart the cloud. Never lower it: an edge that already holds the higher version keeps hashing new PINs under it, and the cloud drops those PINs. Do NOT change `STAFF_PIN_PEPPER` for a routine rotation. Each edge fetches the new tenant pepper on its next sync; until then it still hashes new PINs under the old version, which stay valid. PINs hashed under an older version keep verifying, on the cloud and on every edge, until the owner sets a new PIN; a new PIN is hashed under the current version.
   - **Suspected edge theft.** First revoke that node's credential (an edge with a valid credential fetches every new pepper on its next sync). Then rotate the version, and have that outlet's staff set new PINs.
   - **Leak of the root.** Replace `STAFF_PIN_PEPPER` AND raise `STAFF_PIN_PEPPER_CURRENT_VERSION` in the same release. Every PIN then needs a reset. An edge keeps the peppers it already holds (derived from the old root) for the old versions, so a root replacement without a version bump leaves edges on stale peppers.
4. **Credential rotation.** The seal key comes from the node credential. After you issue a new credential, the edge cannot open its stored peppers, treats them as missing, and fetches them again on the next sync (online).
5. **Never** copy the root pepper to an edge to "fix" a verification problem, and never log or paste the `peppers` of a sync response.

## Attendance selfie seal key (legend-0wvoz, founder decision Q88)

An edge node seals each attendance selfie to a cloud public key (format `LSS1`, `docs/design/hris-edge-replication.md` section 5) and uploads it with `PUT /api/edge-sync/attendance-selfies/:objectId`. Only the cloud can open it, with the private key. Lose the private key and every selfie still waiting on an edge disk is unreadable. The key is a production secret with a founder backup.

Environment (cloud API only, never on an edge):

- `ATTENDANCE_SELFIE_SEAL_KEYS`: JSON `{"<kid>": "<PKCS#8 PEM>"}`, 3072-bit RSA. One entry per key still in use.
- `ATTENDANCE_SELFIE_SEAL_ACTIVE_KID`: the kid whose public half edges seal to.
- Without the keys the endpoint answers 503 `SELFIE_SEAL_KEY_MISSING`; the edge keeps the file and retries.

Create the first key (on a trusted machine, not in the repo, not in chat):

1. `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out seal-k1.pem` (PKCS#8 PEM).
2. Public half for the edge snapshot: `openssl pkey -in seal-k1.pem -pubout -out seal-k1.pub.pem`.
3. Build the JSON value without printing it, for example `node -e 'process.stdout.write(JSON.stringify({k1: require("fs").readFileSync("seal-k1.pem","utf8")}))'`, and put it straight into the production secret store under `ATTENDANCE_SELFIE_SEAL_KEYS`. Set `ATTENDANCE_SELFIE_SEAL_ACTIVE_KID=k1`.
4. Founder backup: store `seal-k1.pem` as a secure note or document in the founder's 1Password vault, named `legend attendance selfie seal key k1`. The CTO asks for the value with `ghostex secret request`; nobody pastes it in chat.
5. Delete the local `seal-k1.pem` after both stores are confirmed. Restore test: decrypt one sealed test file with the backup copy before the first real edge goes live.

Rotation: add a new kid to `ATTENDANCE_SELFIE_SEAL_KEYS`, switch `ATTENDANCE_SELFIE_SEAL_ACTIVE_KID`, and keep the old private key for 90 days after the switch (an edge cut off from the cloud keeps sealing with the old kid until its next snapshot). Retire the old key on that date, in both stores. An emergency retirement (key leaked) knowingly loses the backlog sealed with the old kid.

Release order: cloud first (this endpoint and the `attendance.logged` v2 applier), then the edges. Cloud orphan sweep: a received selfie that no attendance log references after 14 days is deleted from storage (the receipt stays).

## Rotasi kunci data (DATA_ENCRYPTION_KEY)

Rahasia tersegel lewat `sealSecret` dan `openSecret` (`apps/api/src/lib/secrets.ts`) memakai byte pertama amplop sebagai versi kunci. Versi 1 adalah `DATA_ENCRYPTION_KEY`; versi 2 sampai 255 diambil dari `DATA_ENCRYPTION_KEYS` (`2:<base64>,3:<base64>`, format sama dengan `HRIS_PII_KEYS`). `DATA_ENCRYPTION_ACTIVE_KEY_VERSION` (default 1, harus 1 atau terdaftar) memilih kunci untuk segel baru. Nilai lama tetap terbuka karena versinya terbaca dari amplop. Indeks buta (`blindIndex`) selalu memakai versi 1, jadi `DATA_ENCRYPTION_KEY` tetap harus diisi.

Rotasi dua rollout. Alasannya: proses yang ring-nya belum mengenal versi N tidak bisa membuka amplop berbayte N dan gagal dengan galat `Unknown sealed value version N (not in this process's key ring; ...)`. Kode tidak bisa mendeteksi ini antar-proses, jadi urutannya dijaga operator.

1. Buat kunci dengan `openssl rand -base64 32`. Jangan cetak atau tempel nilainya di chat, log, atau berkas repo.
2. Rollout 1: tambahkan `N:<base64>` ke `DATA_ENCRYPTION_KEYS` di SEMUA proses (api, worker, dan job), lalu tunggu semuanya berjalan dengan env baru. `DATA_ENCRYPTION_ACTIVE_KEY_VERSION` tetap versi lama. Jangan lanjut sebelum tidak ada proses lama yang hidup.
3. Rollout 2: set `DATA_ENCRYPTION_ACTIVE_KEY_VERSION=N` di semua proses, restart, lalu segel ulang kredensial yang sudah tersimpan dengan skrip rotasi:
   `pnpm db:rotate-data-key [--tenant <id>] [--force] [--dry-run]`.
   Skrip berjalan atas semua tenant (termasuk yang suspended atau archived), memanggil `rotateIntegrationCredentials` (integrasi platform) dan `rotateAiProviderKeys` (kunci penyedia AI) dengan aktor `system`, dan mencetak laporan JSON (jumlah per tenant, `totals`, `remaining`, `remainingComplete`; tanpa nilai rahasia, galat non-database memakai pesan tetap). Tenant yang galat dicatat di `totals.failedTenants` dan tenant lain tetap jalan. `--dry-run` hanya menghitung baris yang masih di versi lama dan tidak menulis apa pun. Baris yang sudah di versi aktif dilewati, jadi aman diulang. Kode keluar 1 bila ada tenant gagal, `remainingComplete` false (hitungan sisa satu tenant gagal; tenant itu masuk `failedTenants` dan `remaining` hanya batas bawah), atau `remaining` > 0 setelah jalan sungguhan. Kunci AI yang tidak bisa dibuka dilewati dan dilaporkan di `error` tenantnya. `remaining` menghitung baris semua tenant, juga saat `--tenant` dipakai.
4. Jangan membuang kunci lama dari ring selama masih ada nilai tersegel di bawahnya, termasuk backup yang mungkin dipulihkan. Jangan menurunkan versi aktif.

Rotasi terjadwal (legend-rg8yl): worker menjalankan job `data-key-rotation` tiap hari pukul 03:15 Asia/Jakarta (pg-boss, antrean `exclusive`). Job memanggil fungsi yang sama dengan skrip (`rotateIntegrationCredentials` dan `rotateAiProviderKeys`, tanpa `force`) atas semua tenant, jadi setelah langkah 3 baris yang tertinggal di versi lama ikut tersegel ulang tanpa menunggu operator. Satu instance saja yang berjalan: job mengambil advisory lock `pg_try_advisory_xact_lock(hashtextextended('data-key-rotation', 0))`; bila lock dipegang sesi lain, run dilewati (`skipped: true`) dan tidak menulis apa pun. Lock lepas saat transaksi selesai atau proses mati. Tenant yang galat dicatat dengan id-nya dan job gagal supaya pg-boss mencatatnya; tenant lain tetap jalan dan run berikutnya mencoba lagi. Log hanya berisi jumlah dan id tenant, tidak pernah kunci, ciphertext, atau pesan galat database. Cara memeriksa: cari log worker `Data key rotation finished {...}` (`tenants`, `integrationsRotated`, `aiRotated`, `failedTenants`, `skipped`); run kedua setelah rotasi selesai harus melaporkan `integrationsRotated` dan `aiRotated` 0. Untuk hitungan baris yang tersisa tanpa menulis, pakai `pnpm db:rotate-data-key --dry-run`. Skrip tetap dipakai untuk `--force`, `--dry-run`, dan satu tenant (`--tenant`). Kunci lama tetap tidak boleh dibuang dari ring sebelum job melaporkan 0 dan `--dry-run` menunjukkan `remaining` 0.

Cakupan skrip: hanya `tenant_integrations.credentials_encrypted` dan `ai_provider_configs.api_key_encrypted`, yaitu tabel yang punya kolom versi kunci. Pemakai `sealSecret` lain tidak punya kolom versi dan tidak di-reseal; nilainya tetap terbuka karena amplop membawa versinya selama kunci lama masih ada di ring (jadi kunci lama belum boleh dipensiunkan):

| Pemakai                                                                         | Tempat                                               |
| ------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Rahasia MFA                                                                     | `identity-mfa.service.ts`                            |
| Identitas (`valueEncrypted`, `emailEncrypted`)                                  | tabel identitas                                      |
| NPWP                                                                            | `org.service.ts`, `profit-share-registry.service.ts` |
| Rekening bank                                                                   | kolom rekening tersegel                              |
| Token sesi meja, klaim, split, QR, recovery, reservasi, promo, voucher, receipt | token tersegel per fitur                             |
| Kredensial integrasi dan kunci AI                                               | dirotasi oleh skrip di atas                          |

Pemakai `sealSecret` lain (token ChatGPT, langganan push, dan kolom lain yang terdaftar) tidak lewat skrip ini, melainkan job `sealed-secret-reseal`. Lihat bagian berikut.

### Job `sealed-secret-reseal` dan pensiun kunci (legend-rj284)

Job `sealed-secret-reseal` berjalan tiap Minggu 03:30 Asia/Jakarta (`SEALED_SECRET_RESEAL_CRON`). Job ini memindahkan setiap kolom yang terdaftar di `SEALED_SECRET_COLUMNS` (`apps/api/src/worker/sealed-secret-reseal.job.ts`) ke versi aktif, termasuk:

- `push_subscriptions.subscription_ciphertext`. Kolom `key_version` ikut diisi `v<versi>` saat baris pindah.
- `ai_chatgpt_connections.tokens_encrypted` dan `pending_encrypted`, lewat `resealChatgptConnectionAny` (`apps/api/src/services/ai-chatgpt.service.ts`). Baris yang sedang dipakai operasi ChatGPT (lease, ditambah margin 10 menit) dilewati dan dihitung sebagai `busy`. Job tidak menunggu permintaan pengguna, tidak mengubah `updated_at`, dan tidak pernah memutus atau mencabut koneksi.

Versi lama boleh dikeluarkan dari `DATA_ENCRYPTION_KEYS` hanya jika laporan lengkap job terakhir memenuhi SEMUA syarat ini untuk setiap kunci:

- `aborted` = false;
- `failedTenants` = 0;
- `failed` = 0 dan `remaining` = 0 untuk SETIAP entri `tables` di laporan (registry di bawah), bukan hanya tiga kolom baru. Baris `frozen` dan `busy` ikut dihitung di `remaining`: satu baris `frozen` atau `busy` yang tersisa di kolom mana pun menahan pensiun;
- cek `rotate-data-key` dan `hris-pii-reseal` di bagian sebelumnya juga terpenuhi.

Registry yang harus bersih (persis dari `sealed-secret-reseal.job.ts`). Kunci laporan `tables` berbentuk `<tabel>.<kolom>`:

| Sumber                               | Entri `<tabel>.<kolom>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Catatan                                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SEALED_SECRET_COLUMNS` (global)     | `mfa_factors.secret_encrypted`, `user_identities.value_encrypted` (hanya `type` `whatsapp` dan `email`), `login_challenges.email_encrypted`                                                                                                                                                                                                                                                                                                                                                                                                                                    | Tanpa `tenant_id`.                                                                                                                                             |
| `SEALED_SECRET_COLUMNS` (tenant)     | `legal_entities.npwp_encrypted`, `shareholders.npwp_sealed`, `shareholders.payout_account_sealed`, `bank_accounts.account_number_encrypted`, `tables.qr_token_sealed`, `table_sessions.session_token_sealed`, `bill_splits.claim_token_sealed`, `orders.payment_link_token_sealed`, `orders.claim_token_sealed`, `reservations.deposit_link_sealed`, `apology_vouchers.code_sealed`, `pos_receipt_deliveries.destination_sealed`, `pos_order_tenders.payment_link_token_sealed`, `order_issue_charges.payment_link_token_sealed`, `push_subscriptions.subscription_ciphertext` | `bank_accounts.account_number_encrypted` bertipe `bytea`, sisanya teks base64. `push_subscriptions` memperbarui `key_version` (`v<versi>`) bersama ciphertext. |
| `SEALED_JSON_SECRETS`                | `promo_command_idempotency.response` operasi `voucher.issue` (path `code`) dan operasi `apology_voucher.issue` (path `voucher.code`, hanya `response ->> 'kind' = 'issued'`)                                                                                                                                                                                                                                                                                                                                                                                                   | Dua entri berbagi satu kunci laporan. Kunci baris `key`, bukan `id`.                                                                                           |
| `SEALED_SERVICE_SWEEPS` (per tenant) | `ai_chatgpt_connections.tokens_encrypted`, `ai_chatgpt_connections.pending_encrypted`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Hanya di sini ada `busy` (lease operasi ChatGPT ditambah margin 10 menit).                                                                                     |

Baris `frozen` (database menolak UPDATE biasa): `orders.payment_link_token_sealed` dan `orders.claim_token_sealed` saat `status` `completed` atau `voided`, `pos_order_tenders.payment_link_token_sealed` saat order induknya `completed` atau `voided`, dan semua baris `apology_vouchers.code_sealed`. Job memindahkannya sendiri lewat pass beku: tiap baris dipindah oleh fungsi database `app.reseal_frozen_sealed` setelah `SET LOCAL ROLE legend_sealed_reseal`, hanya pada kolom tersegel itu, dengan compare-and-set dan tidak pernah menurunkan versi. Sebelum dikirim, job membuka amplop baru dengan AAD yang sama dan membandingkan plaintext-nya. Kolom lain, status voucher, dan kolom uang tidak disentuh. Kursor pass beku disimpan di `sealed_secret_reseal_state` dengan `column_name` berakhiran `#frozen`. Baris beku yang gagal dihitung `failed` dan tetap di `remaining`, jadi menahan pensiun sampai run berikut memindahkannya; tidak perlu pengecualian CTO. Sesudah run sukses, `remaining` dan `frozen` bernilai 0.

Job tidak pernah menghapus nilai atau memutus koneksi. Nilai yang tidak bisa dibuka tetap `failed` dan menahan pensiun. Log hanya menyebut tabel, kolom, dan id tenant (hanya untuk scope yang gagal karena galat database), tidak pernah nilainya. Laporan job hanya berisi angka: TIDAK ada daftar id baris yang gagal. Untuk tahu baris mana yang menahan pensiun, pakai query read-only di bawah.

#### Mencari baris yang menahan pensiun (read-only)

Versi di dalam amplop adalah byte pertama nilai (setelah decode base64 untuk kolom teks). Job memakai byte itu, bukan kolom `key_version`, untuk menentukan baris mana yang masih lama. Query berikut memakai penyaring yang sama dan mencetak hanya id, tidak pernah ciphertext atau token.

Aturan pakai:

- Jalankan setelah run kedua job. Sebelum itu daftar masih berisi baris yang belum sempat dipindah. Setelah run kedua, sisanya adalah baris `failed`, `frozen` (gagal di pass beku), atau `busy`.
- Jalankan sebagai superuser atau role dengan `BYPASSRLS` (role migrator), dalam transaksi read-only. Tabel tenant memakai row-level security, jadi role aplikasi gagal dengan 42501.
- Ganti `N` dengan versi aktif (`activeVersion` di laporan). Jangan `SELECT` kolom ciphertext, dan jangan tempel hasil `SELECT` kolom itu di chat atau log.
- Banyak baris hasil query harus sama dengan `remaining` kolom itu di laporan. Bila `failedTenants` > 0, hitungan tenant yang gagal itu tidak lengkap: jalankan ulang job dan baca lognya dulu.

Push (id baris untuk langkah hapus di bawah):

```sql
BEGIN READ ONLY;
SELECT t.tenant_id, t.id, t.user_id, t.key_version
FROM public.push_subscriptions t
WHERE CASE WHEN t.subscription_ciphertext ~ '^[A-Za-z0-9+/]{4}'
           THEN get_byte(decode(substring(t.subscription_ciphertext from 1 for 4), 'base64'), 0)
      END < N
ORDER BY t.tenant_id, t.id;
ROLLBACK;
```

ChatGPT (cukup id tenant, karena langkah operator per tenant). Ganti `<kolom>` dengan `tokens_encrypted` lalu `pending_encrypted`:

```sql
BEGIN READ ONLY;
SELECT t.tenant_id, t.id, t.status, t.operation_lease_until
FROM public.ai_chatgpt_connections t
WHERE CASE WHEN t.<kolom> ~ '^[A-Za-z0-9+/]{4}'
           THEN get_byte(decode(substring(t.<kolom> from 1 for 4), 'base64'), 0)
      END < N
ORDER BY t.tenant_id;
ROLLBACK;
```

Baris dengan `operation_lease_until` kurang dari 10 menit yang lalu atau di masa depan adalah `busy`: tunggu lalu jalankan ulang job, jangan putus koneksinya.

Kolom lain di registry: pakai pola yang sama dengan `<tabel>` dan `<kolom>` dari tabel di atas.

- Kolom teks: persis pola ChatGPT di atas, tanpa `status` dan `operation_lease_until`.
- `bank_accounts.account_number_encrypted` (`bytea`): `WHERE length(t.account_number_encrypted) > 0 AND get_byte(t.account_number_encrypted, 0) < N`.
- Tabel global (`mfa_factors`, `user_identities`, `login_challenges`): buang `t.tenant_id`. Untuk `user_identities` tambahkan `AND t.type IN ('whatsapp','email')`.
- `orders` memakai id ULID yang disimpan sebagai uuid; id yang tercetak adalah uuid-nya.
- `promo_command_idempotency`: kunci baris `t.key`, nilai di `t.response` pada path JSON tiap entri (`code` atau `voucher.code`), dengan `operation` dan `where` entri yang sama.

Langkah operator per tenant, setelah run kedua masih menunjukkan baris `failed`:

- ChatGPT: pemilik tenant memutus ChatGPT di pengaturan Tanya AI, lalu menghubungkannya lagi. Putus menghapus kedua kolom.
- Push: hapus baris `push_subscriptions` yang tidak terbaca milik tenant itu, per `tenant_id` dan `id` dari query di atas. Perangkat mendaftar ulang saat aplikasi dibuka berikutnya. Pengguna di perangkat itu tidak menerima notifikasi sampai saat itu.

Pensiun dengan `failed` > 0 atau `failedTenants` > 0 berarti menerima kehilangan itu untuk tenant terkait. Keputusan ini butuh persetujuan CTO.

Catatan: penulisan baru HRIS dan payroll versi 1 (`pii_key_version = 1`) tetap di bawah kunci 1 lewat `sealSecretBaseKey`, BUKAN kunci data aktif; pembacaan lewat `openSecret` membaca byte versi amplop. Kunci 1 (`DATA_ENCRYPTION_KEY`) tidak bisa dipensiunkan selama masih ada baris versi 1. Memindahkannya ke kunci HRIS bernomor 2 ke atas dilakukan lewat rotasi HRIS di bawah.

## Rotasi kunci HRIS dan payroll

Versi kunci 1 adalah `DATA_ENCRYPTION_KEY`. Versi 2 dan seterusnya diambil dari `HRIS_PII_KEYS`. Data HRIS yang disegel (karyawan dan kontrak) serta dua kolom payroll (`employee_pay_components.amount_encrypted` dan `payslips.calculation_encrypted`) memakai ring kunci yang sama. Kolom `pii_key_version` mencatat versi yang dipakai tiap baris. Job reseal ikut memindahkan kedua tabel payroll.

Rotasi ke versi `N` (angka baru, lebih besar dari versi aktif):

1. Buat kunci 32 byte dalam base64, misalnya `openssl rand -base64 32`. Jangan cetak atau tempel nilainya di chat, log, atau berkas repo.
2. Tambahkan `N:<base64>` ke `HRIS_PII_KEYS`. Pisahkan dengan koma jika sudah ada entri. Simpan kunci lama.
3. Set `HRIS_PII_ACTIVE_KEY_VERSION=N`.
4. Restart API dan worker. Keduanya harus membaca env yang sama, karena data baru disegel dengan versi aktif.
5. Antrikan job `hris-pii-reseal` dengan `{"targetKeyVersion": N}`. Job tanpa nilai itu, atau dengan versi lain, ditolak.
6. Tunggu log selesai. Pastikan `failed` dan `incomplete` bernilai 0 di semua tenant, termasuk tenant yang suspended. Job bekerja per batch, idempotent, dan bisa dilanjutkan: jika terputus, jalankan ulang job yang sama. Baris yang sudah versi `N` dilewati.
7. Cek di database sebagai superuser atau role dengan BYPASSRLS (tabel-tabel ini memakai row-level security; tanpa konteks tenant, role aplikasi gagal dengan 42501). Setiap query harus mengembalikan 0:

```sql
SELECT count(*) FROM employees WHERE pii_key_version <> N;
SELECT count(*) FROM employment_contracts WHERE pii_key_version <> N;
SELECT count(*) FROM employee_pay_components WHERE pii_key_version <> N;
SELECT count(*) FROM payslips WHERE pii_key_version <> N;
```

Baris payroll hanya bisa pindah ke versi yang LEBIH TINGGI (dijaga trigger database, dan tidak pernah di atas versi aktif yang dibawa job). Jadi jangan menurunkan `HRIS_PII_ACTIVE_KEY_VERSION` setelah job pernah jalan. Untuk membatalkan kunci yang buruk, tambahkan materi kunci lama sebagai versi BARU yang lebih tinggi (`N+1`), set versi aktif ke `N+1`, lalu jalankan job reseal dengan `{"targetKeyVersion": N+1}`.

Versi lama boleh dipensiunkan dari `HRIS_PII_KEYS` hanya jika kedua syarat ini terpenuhi: cek di atas bernilai 0 di setiap tenant, dan backup yang dibuat sebelum rotasi tidak lagi dibutuhkan untuk restore. Jika backup lama masih perlu di-restore, simpan kunci lama itu, atau jalankan ulang job reseal setelah restore.

Versi 1 (`DATA_ENCRYPTION_KEY`) tidak bisa dipensiunkan dengan rotasi ini. Kunci itu masih dipakai oleh:

- Rahasia tersegel lain lewat `sealSecret` dan `openSecret` di `apps/api/src/lib/secrets.ts`, misalnya token QR, struk POS, token deposit reservasi, PIN payslip, recovery code MFA, kredensial integrasi platform, dan NPWP. Daftar pemanggilnya: `grep -rl "sealSecret(" apps/api/src`.
- Blind index HMAC: versi 1 memakai `DATA_ENCRYPTION_KEY` langsung (`blindIndex` di `lib/secrets.ts`), versi 2 memakai subkey HKDF darinya (`lib/blind-index.ts`). Keduanya tetap turunan kunci ini, jadi blind index tidak ikut rotasi `HRIS_PII_KEYS` (lihat bagian "Versi blind index" di bawah).
- Fallback `DATA_ENCRYPTION_KEY ?? BETTER_AUTH_SECRET` untuk HMAC token (misalnya `services/qr-token.ts`, `pos-receipt-delivery.service.ts`, `purchasing-send.service.ts`).

Jadi `DATA_ENCRYPTION_KEY` harus tetap di env production. Mengganti nilainya akan membuat rahasia tersegel di atas tidak bisa dibuka dan blind index berubah. Rotasi ini hanya memindahkan data HRIS dan payroll yang disegel ke versi baru.

### Versi blind index (legend-n039)

Blind index (kolom `employees.*_hmac`, `legal_entities.npwp_hash`, dan fingerprint idempotency HRIS) punya versi sendiri, terpisah dari ring `HRIS_PII_KEYS`. Versi 1 adalah HMAC dengan `DATA_ENCRYPTION_KEY` langsung (data lama). Versi 2 adalah HMAC dengan subkey HKDF dari kunci yang sama, jadi kunci yang mengindeks nilai bukan kunci yang menyegelnya, dan tidak ada secret baru. `BLIND_INDEX_ACTIVE_VERSION` (1 atau 2, default 1) menentukan versi untuk tulisan baru. Default 1 sengaja: saat rolling deploy pod lama tidak bisa membaca digest versi 2, jadi versi 2 dinyalakan manual setelah semua pod menjalankan build baru. Kolom `employees.blind_index_version` dan `legal_entities.npwp_hash_version` (migrasi `0265`, default 1) mencatat versi tiap baris.

Rilis ke versi 2:

1. Jalankan migrasi `0265`, lalu deploy API dan worker dengan `BLIND_INDEX_ACTIVE_VERSION` belum diisi (versi 1). Tunggu sampai semua pod API dan worker menjalankan build baru, tidak ada pod lama yang tersisa.
2. Setelah semua pod menjalankan build baru, set `BLIND_INDEX_ACTIVE_VERSION=2` di API dan worker lalu restart. Baru sesudah itu antrikan job `blind-index-rebuild` dengan `{"targetVersion": 2}`. Job tanpa nilai itu, atau dengan versi lain dari versi aktif worker, ditolak. Job idempotent, per batch, dan bisa dijalankan ulang. Sebelum menulis ulang sebuah baris, job memeriksa bahwa digest barunya tidak bentrok dengan baris lain di tenant yang sama.
3. Pastikan log selesai dengan `failedTenants`, `incompleteTenants`, dan `conflicts` bernilai 0 di semua tenant, termasuk yang suspended. Cek di database sebagai superuser atau role dengan BYPASSRLS; keduanya harus 0:

```sql
SELECT count(*) FROM employees WHERE blind_index_version <> 2;
SELECT count(*) FROM legal_entities WHERE npwp_hash_version <> 2;
```

Selama dua versi hidup bersama, unique index `(tenant, digest)` tidak melihat nilai yang sama di versi 1 dan 2. Karena itu penulisan NIK, NPWP, BPJS, dan NPWP badan usaha mengambil lock per tenant lalu memeriksa kedua versi, dan job memakai lock yang sama. Pengecualian: saat rolling deploy, pod lama menulis versi 1 tanpa lock itu. Duplikat yang lolos hanya bisa antara versi 1 dan 2, dan job melaporkannya sebagai `conflicts` (log berisi id tenant, id baris, dan nama kolom, tidak pernah nilainya). Baris itu tetap di versi lama sampai orang memperbaiki datanya, lalu job dijalankan ulang.

Konflik itu permanen: data harus diperbaiki orang. Karena itu job tidak gagal karena `conflicts` (pg-boss tidak mengulangnya terus), hanya mencatat error dan melaporkan `conflicts` di hasil. Job gagal dan diulang pg-boss hanya bila ada tenant `failedTenants` atau baris stale yang terkunci transaksi lain (`retryableTenants`). Setelah data diperbaiki, antrikan job lagi.

Mode verify: `{"targetVersion": 2, "verify": true}` memindai SEMUA baris, bukan hanya yang versinya `<>` aktif, menghitung ulang digest aktif dari nilai tersegel, dan menulis ulang baris yang digest atau versinya berbeda (lock dan pemeriksaan bentrok lintas versi sama dengan mode biasa). Hasilnya melaporkan `rewrites` dan `skipped`. `skipped` adalah baris yang tidak bisa diperiksa karena dikunci transaksi lain; baris terkunci dihitung terlewat walau digestnya benar. Tenant dengan `skipped` lebih dari 0 dianggap `incompleteTenants` dan `retryableTenants`, sehingga job gagal dan diulang pg-boss. Verify bersih hanya bila `skipped` 0 dan `rewrites` 0. Kolom versi saja bukan bukti: baris bisa berversi aktif dengan digest yang ditulis versi lain.

Rollback: set `BLIND_INDEX_ACTIVE_VERSION=1` di API dan worker, restart, antrikan job dengan `{"targetVersion": 1}`, lalu cek 0 baris dengan versi `<> 1`. Job memindahkan baris ke dua arah. Build ini membaca kedua versi fingerprint idempotency (1 dan 2) walau versi aktif 1, jadi retry di sekitar pergantian tetap menjawab dengan hasil tersimpan, bukan menjalankan tulisan lagi atau gagal dengan `IDEMPOTENCY_KEY_REUSED` palsu.

Rollback kode (kembali ke build sebelum kartu ini) hanya aman bila tidak ada baris di versi 2, karena kode lama hanya mengenal digest versi 1. Urutannya: set `BLIND_INDEX_ACTIVE_VERSION=1` di API dan worker, restart, antrikan job `{"targetVersion": 1}`, cek 0 baris dengan versi `<> 1` (dua query di atas dengan `<> 1`), baru kembalikan kode. Tulisan baru juga memakai versi 1 selama pengaturan itu aktif, jadi tidak ada baris versi 2 baru. Build berikutnya (setelah rollback) tetap membaca kedua versi fingerprint idempotency, jadi respons tersimpan dengan fingerprint versi 2 tetap diputar ulang.

Versi 1 belum boleh dihapus dari kode: itu butuh kartu lanjutan yang membuktikan 0 baris di versi 1 di semua tenant dan masa simpan idempotency sudah lewat. Bukti itu wajib memuat satu run verify (`{"targetVersion": 2, "verify": true}`) dengan `skipped` 0, `rewrites` 0, `conflicts` 0, `failedTenants` 0, dan `incompleteTenants` 0 di semua tenant. Rekening bank (`bank_accounts`) ikut dibangun ulang dan diverifikasi job ini (legend-v0kta), dengan lock `acc-cashbank:<tenant>:<badan usaha>` yang sama dengan penulisnya. Kode recovery MFA tidak punya kolom versi dan dicocokkan ke kedua digest, jadi menghapus versi 1 juga butuh 0 set recovery code yang dibuat sebelum cutover v2 (`created_at` < waktu cutover), atau set lama itu dibuat ulang lebih dulu. `mfa-recovery-code.ts` masih memakai `blindIndex` lama dan di luar lingkup job ini.

## Edge host (outlet) (legend-svy91)

> Urutan rilis katalog edge (`syncTxid`, cursor `cat2`): cloud dulu, baru edge. Lihat `docs/runbooks/edge-catalog-deploy-order.md` (legend-dciax).

Ringkasan untuk host edge di outlet. Langkah lengkap ada di `deploy/edge/README.md`, dan respons jika edge hilang atau dicuri ada di `docs/runbooks/edge-hilang-dicuri.md`.

- **Urutan rilis placeholder antrean (legend-3k41y): update semua edge dulu, baru cloud.** Saat brand outlet pindah, cloud mengganti baris katalog basi di antrean node dengan event no-op `edge_link.dead_lettered` pada nomor urut yang sama (salinan lengkap event disimpan di `edge_link_dead_letters`, reason `brand_moved`), supaya `panic_alert`, `qr_order`, dan `wifi_quota` di belakangnya tetap sampai tanpa lubang nomor. Edge yang belum membawa applier no-op itu (`registerEdgeLinkPlaceholderApplier`) tidak bisa mengklasifikasi event tersebut, sehingga seluruh batch ditolak dan alarm panik di belakangnya macet sampai edge dinaikkan. Karena itu image edge harus berversi `EDGE_NODE_VERSION` >= `EDGE_LINK_PLACEHOLDER_MIN_VERSION` (`packages/shared/src/edge/link-dead-letter.ts`) sebelum cloud yang membawa perubahan ini dirilis. Link tidak ditolak untuk edge lama, tetapi cloud mencatat peringatan `Edge below placeholder version` di log setiap hello dari edge di bawah versi itu; pelanggaran urutan terlihat di sana. Peringatan itu hanya muncul bila `EDGE_NODE_VERSION` diisi semver (default `dev` tidak pernah memicunya): beri image edge tag semver saat build atau deploy (`deploy/edge/README.md`). Tidak ada edge lama di production saat ini (kode edge belum dirilis), jadi aturan ini mencegah masalah, bukan memulihkannya.
  - **Beda dengan urutan sync katalog.** `docs/runbooks/edge-catalog-deploy-order.md` mewajibkan cloud dulu, edge kemudian (legend-dciax). Rilis pertama yang membawa keduanya: belum ada edge lama di lapangan dan edge baru belum punya katalog tersinkron, jadi cloud dulu aman asalkan tidak ada perpindahan brand outlet sebelum semua edge berversi >= `EDGE_LINK_PLACEHOLDER_MIN_VERSION`. Begitu ada edge lama di lapangan, rilis berikutnya yang menyentuh antrean ini memakai urutan edge dulu: sync katalog edge berhenti sementara (gejala "edge baru, cloud lama" di runbook itu: data lama dipakai, checkpoint tidak maju, tidak ada data hilang) sampai cloud naik beberapa saat kemudian; naikkan cloud segera setelah edge outlet percobaan sehat.
- **Volume selfie.** Selfie yang menunggu upload disimpan di `EDGE_SELFIE_DIR` (default `/var/lib/legend/edge-selfies`, volume Docker). Direktori tenant dibuat dengan mode 0700 dan file `.lss` dengan mode 0600. Batas `EDGE_SELFIE_MAX_BYTES` (default 2 GiB). Di atas batas itu edge menjawab 507 `EDGE_SELFIE_STORAGE_FULL`.
- **Volume state.** Antrean alarm owner (jam tak terbukti dan katalog basi) disimpan di `EDGE_STATE_DIR` (default `/var/lib/legend/edge-state`), volume tersendiri, terpisah dari volume selfie. Buat direktori ini sebelum edge pertama jalan: dimiliki service user, mode 0700. API membuatnya sendiri hanya bila direktori induknya bisa ditulis, dan bila gagal alarm hanya hidup di memori sampai restart. `deploy/edge/check-edge-host.sh` memeriksa keberadaan, mode 0700, dan pemilik (opsi `--state-dir`). Alarm lama di `EDGE_SELFIE_DIR/catalog-alarms` diimpor sekali lalu dihapus saat edge pertama jalan dengan versi ini.
- **NTP wajib.** Jam edge dan jam HP harus berada dalam satu jendela QR 30 detik, jadi edge memakai chrony (lihat `deploy/edge/chrony.conf.example`).
- **HTTPS wajib untuk perangkat outlet.** Kamera butuh secure context. Origin edge di perangkat outlet memakai HTTPS dengan sertifikat dari CA internal yang dipercaya perangkat (lihat `deploy/edge/Caddyfile.edge.example`).
- **Enkripsi disk penuh (FDE) dengan unlock TPM** pada mini PC edge sebagai lapisan tambahan. Wajib jika enkripsi selfie cadangan dengan AES dipakai.
- **Kunci publik seal datang lewat snapshot.** Edge menyegel selfie dengan kunci publik cloud dari snapshot data orang (`edge_people_sync_state.selfie_seal_public_key`, `selfie_seal_kid`). Tidak ada kunci yang disalin manual ke disk edge.
- **Edge tidak pernah memegang kunci privat.** `ATTENDANCE_SELFIE_SEAL_KEYS` dan `ATTENDANCE_SELFIE_SEAL_ACTIVE_KID` hanya ada di cloud. Prosedur kunci produksi ada di section "Attendance selfie seal key" di atas, jangan diduplikasi.

### EDC agent (legend-kwy6d)

Agen EDC (mesin kartu) jalan di proses edge, bukan di worker cloud, karena edge yang memegang perangkat. Dihidupkan dengan `EDC_AGENT_ENABLED=true` (default mati) di file env edge. Identitas tenant dan outlet diambil dari kredensial node, tidak pernah dari request. Registry produksi tidak punya simulator; adapter bank menyusul (legend-vpx), jadi sebelum itu setiap bank dijawab `EDC_PROVIDER_UNKNOWN` dan tidak ada transaksi yang dikirim.

- **Satu agent per outlet.** Agen mengambil advisory lock Postgres untuk outletnya. Proses kedua untuk outlet yang sama gagal start (`EDC_AGENT_NOT_READY`): kegagalan itu dicatat, edge tetap jalan tanpa agen EDC dan mencoba lagi dengan backoff (lihat Retry).
- **Standby tidak menjalankan.** Hanya node `EDGE_NODE_ROLE=primary` yang memulai agen. Standby tidak pernah membuka pertukaran dengan terminal.
- **Siapa yang merestart.** Bila kunci outlet hilang saat ada sale di kawat, agen mengakhiri proses (`process.exit(1)`) supaya proses lain tidak mengirim sale yang sama. Supervisor wajib menyalakannya lagi: systemd `Restart=always` dengan `RestartSec` (contoh `deploy/edge/legend-edge.service`), atau `restart: always` bila edge jalan di Docker. Tanpa supervisor, EDC mati sampai ada yang menyalakan edge.
- **Marker kawat dibiarkan.** Saat proses mati, `sale_wire_open_at` pada transaksi tetap ada. Hanya proses yang sudah lewat jendela late-response yang membersihkannya (sapuan agen tiap 60 detik). Restart cepat tidak membersihkannya dan tidak mengirim ulang sale itu: baris `pending` milik proses mati menjadi `unknown` untuk rekonsiliasi.
- **Shutdown.** Agen berhenti sebelum runtime edge dan menunggu sale yang sedang di kawat sampai `saleTimeoutMs` (120 detik). Dengan EDC aktif, timer paksa di `server.ts` adalah `saleTimeoutMs` + 10 detik (130 detik), bukan 5 detik, dan `TimeoutStopSec` unit systemd harus lebih besar (contoh: 150). Memotongnya TIDAK aman: bukti approval sale yang sedang di kawat bisa hilang. Matinya proses memang melepas lock outlet dan marker kawat tetap sampai jendela late-response lewat, tetapi itu hanya mencegah sale kedua, bukan menyimpan hasil sale pertama. Deploy edge berarti menunggu sampai 2 menit bila ada sale berjalan.
- **Retry.** Start yang gagal (outlet dipegang proses lain yang sedang mati, database mati) dan kunci outlet yang hilang tanpa sale di kawat tidak mematikan agen untuk selamanya: edge membangun agen baru dan mencoba lagi dengan backoff (1 detik, berlipat, maksimum 30 detik) sampai edge berhenti. Selama itu `getEdgeEdcAgent()` null. Unit systemd memakai `StartLimitIntervalSec=0` di `[Unit]` supaya restart setelah fail-stop tidak pernah berhenti.

## Support read_write owner approval release (legend-c9kbk)

From migration `0160_support_access_requests`, a Super Admin's read_write support session needs the tenant owner's approval first (founder Q37). Release it like this:

1. **Order.** Apply the migration first, then roll out the API and the worker together. Between the two steps, an old API instance can still try to open a read_write grant directly. The database refuses it, because new read_write grants must name an approved request (`support_access_grant_write_approved_check`). Read_only grants keep working as before.
2. **Grants already open.** Read_write grants that were open before the migration keep working until they expire, at most 30 minutes. The check is added `NOT VALID`, so those rows are not checked.
3. **Owner permission.** The migration adds `org.support_access.approve` to the owner role of every existing tenant. A tenant created by an old API instance after the migration and before the rollout misses it, so its owners get 403 when they approve. Rerun the backfill block at the end of `0160` once the rollout finishes (it is idempotent).
4. **Web.** Until UI card legend-8r77t ships, the platform request dialog can only open read_only sessions. A read_write request answers 409 `SUPPORT_ACCESS_OWNER_APPROVAL_REQUIRED`. Use `POST /api/platform/tenants/:tenantId/support-access-requests` instead, and have the owner answer with `POST /api/org/support-access/requests/:requestId/approve`.

## Platform payment gateway switch (legend-0orff)

Until the Super Admin panel ships, switch DOIT and Duitku with `pnpm --filter @starter/api gateway:set <doit|duitku> [--enabled|--disabled] [--default] [--actor <operator email>]` (source checkout), or `node dist/set-gateway.js` with the same arguments inside the API image, which has no pnpm or tsx; either way it needs the API environment (`DATABASE_URL` or `APP_DATABASE_URL`, and the Duitku settings). It runs the same writer as `PUT /api/platform/payment-gateways/:provider`, so each change adds a `platform_payment_gateway_changes` row (actor `system:cli`, or the email given to `--actor`) and keeps the webhook window and secret grace. Both gateways can stay enabled; `--default` picks the one new tenants get. It refuses a default on a disabled gateway, switching off the last active gateway, switching off the current default (pick another default first) and enabling Duitku without `DUITKU_CALLBACK_BASE_URL` and `DUITKU_RETURN_URL`. The API process caches the registry for 30 seconds, so a change shows within that time.

## Kirimdev inbound WhatsApp (legend-s5rgo)

Customer WhatsApp sign-in (`MASUK <brand> <KODE>`) and payslip PIN reset (`RESET PIN <KODE>`) both arrive as signed Kirimdev `message.received` webhooks at `POST /api/webhooks/whatsapp`. Outbound replies stay off by default (`NOTIFICATION_WHATSAPP_PROVIDER=disabled`, no `KIRIM_API_KEY`). Kirimdev has no sandbox: develop with `scripts/wa-simulate-inbound.mjs`.

1. **Account and number.** Create the Kirimdev account and plan, connect one WhatsApp number per tenant, and finish Meta Business verification. One number can be active in only one tenant (two unique indexes enforce it).
2. **Find the `phoneNumberId`.** `GET /v1/accounts` with the Kirimdev API key (`kdv_live_...`) lists the numbers and their `phoneNumberId`. Registering the subscription needs only this key, used by the person who registers it. The application holds the key (`KIRIM_API_KEY`, optional `KIRIM_API_BASE_URL`) only when outbound is switched on: request it with `ghostex secret request`, never in chat. Until a feature uses it, nothing calls outbound, so setting the key sends no message. Free-text messages work only inside 24 hours of the customer's last inbound message; outside that window Kirimdev answers `outside_24h_window` and the application does not retry. Outbound can incur Kirimdev plan and Meta charges (see `docs/plan/providers.md`), and the write limit is 60 per minute per organization on Starter.
3. **Register the subscription.** `POST /v1/webhook_subscriptions` with the public URL `https://<api-origin>/api/webhooks/whatsapp`, event `message.received`, and `phone_number_ids` filtered to that tenant's number(s). Kirimdev returns the signing secret once.
4. **Secret.** Ask the founder for it with `ghostex secret request`, never in chat. Set `KIRIM_WEBHOOK_SECRET` on the API (comma separated while rotating, see the runbook). Empty: the webhook answers 503 and creating a PIN reset challenge answers 503.
5. **Tenant row.** Insert or update `tenant_integrations` with `provider = 'whatsapp'`, `status = 'active'`, `config = { "receivingNumber": "628...", "loginKeyword": "MASUK LEGEND" }`. `phoneNumberId` is no longer read from `config` for sending or inbound routing. A platform admin with session MFA sets the sender number with `PUT /api/platform/messaging/kirimdev-senders`, body `{ "tenantId": "<tenant>", "outletId": null, "phoneNumberId": "<id from step 2>" }`. Each tenant has one `phoneNumberId`, and it must be unique across tenants. Without it, WhatsApp login, payslip PIN reset proof, and outbound fail closed.
6. **Check.** Run the production tests in [runbooks/kirimdev-webhook.md](runbooks/kirimdev-webhook.md) once before release.

PIN reset needs a verified WhatsApp number that has been linked to the account for at least 3 days (`WA_PROOF_IDENTITY_MIN_AGE_DAYS`, founder decision 11 Nov 2026). Existing numbers count from the migration time. Employees without one need an HR reset.

## Security checklist

Built in: authenticated and origin-checked API routes, ownership filtered in SQL, sign-in/sign-up rate limits, 100 kB request bodies (including Better Auth's), `httpOnly` `SameSite=Lax` session cookies, helmet on the API, and frame/nosniff/referrer headers (plus HSTS in production) on the web app. Before launch, confirm:

- [ ] Both origins are HTTPS and `NODE_ENV=production` is set on both services. Operator setting: in `api.env` and `web.env` (`NODE_ENV=production`, `BETTER_AUTH_URL=https://api.example.invalid`, `WEB_URL=https://app.example.invalid` in `deploy/single-vm/runtime.env.example`). The API refuses to start in production with an `http://` `BETTER_AUTH_URL` or `WEB_URL`, except on `localhost`, `127.0.0.1`, or `[::1]`.
- [ ] `TRUST_PROXY` matches your proxy hops, so rate limits see real client IPs (two hops with Cloudflare in front of Caddy). Operator setting: `TRUST_PROXY=2` in `api.env`.
- [ ] The origin accepts ports 80 and 443 only from Cloudflare's published IP ranges (<https://www.cloudflare.com/ips/>), so nobody can reach Caddy directly and spoof `X-Forwarded-For`. Docker-published ports bypass `ufw`, so enforce it in the cloud provider's security group (allow 80/443 from the Cloudflare ranges only) or in the `DOCKER-USER` iptables chain (`ACCEPT` each Cloudflare range on `--dport 80,443`, then `DROP` the rest of 80/443). Verify from a non-Cloudflare address that `curl -m 5 http://<origin-ip>/` and `https://<origin-ip>/` are refused. Cloudflare changes its ranges now and then: re-read the list and refresh the rules on a schedule (for example every quarter) and whenever Cloudflare announces a change. Keep `trusted_proxies` in `deploy/caddy/Caddyfile` current too: it is a static copy of the same list, so update it in the same quarterly refresh.
- [ ] `SSR_SHARED_SECRET` is set to the same random value (min 32 characters, `openssl rand -hex 32`) in `api.env` and `web.env`, or deliberately left unset (the API then ignores the visitor IP the web server forwards). Operator setting: key `SSR_SHARED_SECRET` (example `replace_with_openssl_rand_hex_32_output`).
- [ ] `WEB_TRUST_PROXY_HOPS` in `web.env` equals the proxies in front of the web server (default `2` = Cloudflare + Caddy); only read when `SSR_SHARED_SECRET` is set. Check it after any proxy change. Operator setting: example `WEB_TRUST_PROXY_HOPS=2`.
- [ ] The public API rate limits suit the venue: guests behind one NAT address and the web SSR traffic both share a per-IP bucket ([public API rate limits](#public-api-rate-limits)), and a Cloudflare rule covers `/api/qr/` and `/api/public/site/` at the edge.
- [ ] Nothing untrusted is served under `COOKIE_DOMAIN` (see [Domains and cookies](#domains-and-cookies)). Operator setting: `COOKIE_DOMAIN=.example.invalid` in `api.env`.
- [ ] The release composes a single API instance. Before running more than one API instance, `REDIS_URL` is required (shared rate-limit storage); until then the Better Auth rate limits and the login-challenge limits are kept per process, so each extra instance multiplies them (see [scaling](#connection-pooling-and-scaling)).
- [ ] Your proxy or load balancer also caps request bodies and slow uploads. `deploy/caddy/Caddyfile` sets `request_body max_size` (2 MB for API JSON and web, 12 MB for multipart and `PUT` uploads, above the 10 MiB upload caps in the API) and server `timeouts` (`read_header 10s`, `read_body 5m`, `idle 2m`). Raise `max_size` there if an upload cap in the API grows. The same file answers 404 for `/api/internal` and `/api/internal/*`, drops any client-sent `X-Tls-Ask-Token`, and `deploy/caddy/test-caddyfile.sh` guards these rules. On an edge host (`deploy/edge/Caddyfile.edge.example`) set `TRUST_PROXY=1`.
- [ ] `admin` is granted only to people trusted with every account: its only app permission is `user: impersonate`, and impersonation of a tenant user goes through a support grant. Give moderators a narrower role ([roles](backend.md#role-based-access)).
- [ ] Features that create many rows or call paid services have per-user limits.
- [ ] Email verification and password recovery by email: decision (CTO, 20 Nov 2026): the first release ships without them, because no email provider exists yet (bead legend-wwuc). Login uses the existing WhatsApp and PIN flow. Turn them on once the email provider is ready.
- [ ] Content Security Policy with per-request nonces: decision (CTO, 20 Nov 2026): postponed, because it risks breaking server-side rendering. The existing headers stay (framing, `<base>`, plugins). Tracked in a separate P3 bead.

## Local Docker versus hosted data

`compose.dev.yaml` is a local convenience. It publishes PostgreSQL on loopback only and stores data in a named volume. Use PostgreSQL backups or your provider's backup service and test restoration; Docker volumes are persistence, not backups.

Account emails are not verified by the base. Add an email provider for verification and password recovery when needed.

References: [Better Auth Express integration](https://better-auth.com/docs/integrations/express), [Better Auth cookies](https://better-auth.com/docs/concepts/cookies), [TanStack Start hosting](https://tanstack.com/start/latest/docs/framework/react/hosting), [Turborepo Docker guide](https://turborepo.com/docs/guides/tools/docker), [node-postgres pooling](https://node-postgres.com/features/pooling).

## CI quality checks

The workflow runs these checks locally with `pnpm` after `pnpm install --frozen-lockfile`:

```sh
pnpm exec node --test scripts/ci/*.test.mjs
pnpm exec node scripts/ci/tenant-hardcode.mjs
pnpm exec node scripts/ci/color.mjs
pnpm exec node scripts/ci/pending.mjs
pnpm audit --audit-level high
pnpm audit --audit-level critical
pnpm check
pnpm build
```

The tenant-branch and color scanners are heuristics, not proofs: review indirect tenant-specific logic and dynamically constructed colors. The color scanner documents its starter exceptions in source. The in-memory isolation harness in `scripts/ci` verifies the harness only. Application isolation is proven by `apps/api/src/test/tenant-isolation-*.test.ts` (POS orders, menu, payments and refunds, inventory, accounting journals, HRIS): tenant A versus a throwaway tenant B through the real services, the HTTP routes and database RLS as the `legend_app` role. They run inside `pnpm check`; run them alone with `LEGEND_TEST_FILES="src/test/tenant-isolation-pos-menu.test.ts src/test/tenant-isolation-payment-inventory.test.ts src/test/tenant-isolation-accounting-hris.test.ts" pnpm test`. A new tenant-aware module needs a case in one of these files.

The business-logic coverage gate (legend-dd0g) runs inside `pnpm check` in CI (`LEGEND_COVERAGE=1`) and locally with `pnpm test:coverage`. It measures `apps/api/src/services` and `packages/shared/src` with the v8 provider and fails below the floors in `apps/api/vitest.config.ts` (lines 85, statements 84, functions 88, branches 72). Baseline on 12 Nov 2026: statements 87.4%, branches 77.22%, functions 91.51%, lines 89.75%. The PRD target is 80% or more; raise the floors as tests land, branches first. Coverage is meaningful only on the full suite: with `LEGEND_TEST_FILES` the run covers a few files and always fails the floors. Dependency scanning blocks critical advisories; known high findings are reported but do not block while legend-ziit tracks remediation. The high-level audit command returns nonzero for those findings. Do not treat these placeholders as release evidence.

### Lighthouse

The `lighthouse` CI job (after `check`) measures the public menu `/menu` and the guest QR menu `/t/<token>` with Lighthouse 13 in its mobile preset (simulated slow 4G, 4x CPU slowdown). Each page runs three times; the median of every score and metric is compared with the thresholds in `scripts/ci/lighthouse.config.mjs`, and the job fails when any median is out of bounds or a page cannot be measured.

| Check                    | Threshold (median of 3)                                         |
| ------------------------ | --------------------------------------------------------------- |
| Performance              | at least 80                                                     |
| Accessibility            | at least 90                                                     |
| Best practices           | at least 90                                                     |
| SEO                      | at least 90 (not applied to `/t/<token>`, which is not indexed) |
| Largest Contentful Paint | at most 3500 ms                                                 |
| Cumulative Layout Shift  | at most 0.1                                                     |
| Total Blocking Time      | at most 400 ms                                                  |

`is-on-https`, `redirects-http` and `valid-source-maps` are not scored (the run is plain http on localhost and the build ships no source maps; TLS belongs to the edge proxy). Total blocking time may be at most 600 ms. A failing category prints the audits that lost points, and each page's last full report is saved as `test-results/lighthouse/<page>.lhr.json`.

The numbers are looser than Lighthouse's "good" bands because CI runners are small and shared; tighten them in the config file once there is a baseline. Run it locally after a build made for the test API origin (the web bundle inlines `VITE_API_URL`; `pnpm test:e2e` builds the same way):

```sh
NODE_ENV=production VITE_API_URL=http://localhost:4101 heavy pnpm build
pnpm exec playwright install chromium
heavy pnpm lighthouse
```

`pnpm lighthouse --dry-run` prints the plan without starting anything. The script starts a disposable PostgreSQL (Docker), seeds Cafe Legend with a menu and one table QR (`apps/api/src/test/lighthouse-seed.ts`), starts the production API and web servers on the Playwright ports (4101 and 3101), and drives Chromium with `cafe-legend.platform.example` mapped to `127.0.0.1` because tenants resolve by `Host`. To reuse a migrated and seeded test database instead, set `STARTER_TEST_DATABASE_URL` and `STARTER_TEST_RUN` (starting with `starter-pg-test-`). Set `LIGHTHOUSE_CHROME_PATH` to use another Chromium. Results are written to `test-results/lighthouse/summary.json`.

## Single-VM deployment (legend-8br)

The configuration in `deploy/single-vm/compose.yaml` is a starting point for one
small Jakarta VM, with Cloudflare in front of Caddy and private PostgreSQL. It
is not a production readiness certification: measure VM, storage, egress and
backup costs together against the Rp1,000,000/month ceiling. Use separate VMs,
volumes, credentials and synthetic data for staging; staging never receives a
production backup. Choose image tags built and scanned by CI. The image workflow
builds and scans locally in CI and never pushes or deploys.

Build the API (`runner`), web (`runner`), worker, migrator, and edge targets
using the Dockerfiles above; build the backup-enabled PostgreSQL image with
`docker build -f deploy/backup/Dockerfile .`. Edge uses the same web image with
`EDGE_MODE=true`. See `deploy/backup/README.md` for required private pgBackRest
configuration, initialization, two independent encrypted object repositories,
daily backups and isolated restore drills. Configure Biznet Gio S3-compatible
storage as one repository and an independent off-site failure domain as the
other. Monitor archive failures and disk use; the config alone does not prove
RPO or RTO. Complete a real restore drill before launch.

Copy `deploy/single-vm/compose.env.example` outside the repository and set its
values and absolute paths. Create separate private env files for migrator, API,
web and worker; give each process only the credentials it needs. The runtime
example lists settings, not a complete production secret configuration. Provision
restricted app and worker database roles after migration with
`deploy/single-vm/provision-roles.sh` (see "First boot: restricted database
roles" below); configure the worker's trusted transport and notification
adapters before starting it.

#### Worker transport and notification settings (legend-18qw)

The worker refuses to start unless its transport and every notification channel
are configured. Compose sets `WORKER_TRANSPORT=builtin`; put the rest in
`worker.env`:

| Key                              | Values              | Notes                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WORKER_TRANSPORT`               | `builtin`           | Built-in outbox transport. On the cloud a `cloud-sync` event is consumed locally (the consumption row is the durable, idempotent acknowledgement). With `EDGE_MODE=true` it is queued on the authenticated edge link (`/api/edge-link`) to the cloud. `WORKER_TRANSPORT_MODULE` / `WORKER_CONFIG_MODULE` still override it with a trusted module. |
| `NOTIFICATION_EMAIL_PROVIDER`    | `disabled`, `brevo` | Required. `brevo` also needs `BREVO_API_KEY` and `NOTIFICATION_EMAIL_FROM` (optional `NOTIFICATION_EMAIL_FROM_NAME`). The provider account and sender domain (SPF/DKIM) are bead legend-wwuc.                                                                                                                                                     |
| `NOTIFICATION_PUSH_PROVIDER`     | `disabled`          | Required. `web_push` turns on browser alarms (VAPID values below).                                                                                                                                                                                                                                                                                |
| `NOTIFICATION_WHATSAPP_PROVIDER` | `disabled`          | Required. WhatsApp templates are bead legend-hyq.                                                                                                                                                                                                                                                                                                 |

Web push (browser alarm for the panic button, legend-ofq4f): set
`NOTIFICATION_PUSH_PROVIDER=web_push` and the same three `VAPID_*` values in
**both** the API and `worker.env`. The API serves only the public key to signed-in
browsers (`GET /api/notifications/push-key`, `null` while push is off) and
refuses to boot if a value is missing or the pair does not match; the worker
signs and sends.

- `VAPID_PUBLIC_KEY`: base64url, 65-byte uncompressed P-256 point (87 characters).
- `VAPID_PRIVATE_KEY`: base64url, 32 bytes (43 characters).
- `VAPID_SUBJECT`: `mailto:` address or `https://` URL the push service can contact.

Generate the production pair once, on the server, with
`npx web-push generate-vapid-keys`, and keep it in the secret store. Never
commit it, paste it in chat, or reuse the local dev pair that `pnpm run setup`
creates. Rotating the pair invalidates every stored subscription: all browsers
must register again (the panic alarm falls back to its other channels until they
do). Subscriptions are sealed with `DATA_ENCRYPTION_KEY`. The keys and the
subscription endpoints are never logged.

Release checklist: the panic alarm is not ready until
`NOTIFICATION_PUSH_PROVIDER=web_push` and the three `VAPID_*` values are set in
both the API and the worker. With the default `disabled` the worker only logs an
operator error per alarm (no secrets) and the in-app notification is still
written; nothing reaches a locked phone.

Known limits of push registration:

- A push subscription is bound to the login session, not to the PIN. Switching
  user with a PIN on a device does not revoke it.
- Residual risk: a session that expires from idleness without a sign-out, after
  which another user signs in on the same browser and never opens `/fasilitas`.
  The previous user's alarm (while still on duty and authorized) keeps showing
  until 30 days pass or the new user registers.

**Release 1 (Q45): `DOIT_REFUNDS_ENABLED` must be `false` or unset.** No refund
is sent to the payment provider automatically. An approved refund stays
`approved` (the manual queue; the API answers `REFUND_PROVIDER_DISABLED`, the
sweep logs one warning with the count waiting) and finance records the payout
once with `settle-manually` (idempotent, never more than the refund amount, and
refused again when the cap, a provider refund or an open hold no longer allows
it). Provider refund reports are still matched; an odd one is held. Turn the
switch on again only after a clean refund second-opinion review and a founder
decision. The API and the worker log a startup warning when it is on.

While the switch is off, settle in Legend first, then refund in the provider
dashboard (1072 B-1). If the provider report arrives before the settle (wrong
order), it is still recorded as a fact, and the transaction is held with a
conflict hold while the refund is still waiting, so the settle is refused until
finance decides (it is no longer counted twice). If a partial report arrives
after the settle, it is booked as a separate provider refund with no hold (the
books count the money twice, on the restrictive side); a report of the whole
transaction after the settle holds the amount paid by hand. For a hold of this kind, `not_this_intent` may be chosen
once finance has cancelled the waiting refund (when the provider refund is that
refund), or has made sure the provider refund is a separate one (then settle the
refund). Closing is safe without further checks only when the provider fact
with the same refund id is visible on the intent (a report that arrived while
the refund was still waiting). The hold of a matched success that is not a proven
echo (a smaller amount on a refund not yet sent, or a report under the id of a
refund settled by hand) books no fact: do not choose `not_this_intent` when the
report is right. The same holds for a report of the whole payment on an intent
with nothing left to refund. When that report is a dashboard refund of money
already paid by hand (1072 B-1), `not_this_intent` is safe, because the
refund is already counted. That hold (kind `synthetic_full`, reason
transaction conflict) can be closed with `not_this_intent` (1077 R3); counting
it stays refused. A hold of a signed report that names the payment of another
transaction with an unreadable or missing amount (reference mismatch, 1077 R2)
holds the whole payment of that transaction: before counting it, read the real
amount on the provider dashboard (counting books the held amount as refunded).
Counting a recon hold (`count`) is refused while the intent has an `approved`
refund, and settling is refused while a hold is open (1072 B-2): to count a
hold, cancel the waiting `approved` refund first. A hold on a transaction
conflict can only be closed with `not_this_intent`. Outside the wrong-order
case above (where the fact is already booked), do not choose it when the
provider report is right (the money would open up without the surplus booked).
Leave that hold open and the money stays held.
Since refund round 7 (1075), every signed success matched to our refund that
is not a proven echo opens such a hold: a different provider refund id, an
amount larger than the refund, a report on a refund that is failed, refused or
settled by hand, and a report whose amount cannot be read. The last one holds
the full payment amount under an `invalid:` id, because the real amount is
unknown. A report larger than any amount already held for the same provider
refund opens a new hold even after earlier holds were closed. Check the
provider dashboard before closing any of them.

Since refund round 9 (1090), a hold of an unreadable report (the made-up
`invalid:` id) is kept apart from provider refund ids: a real provider refund id
that looks the same is a new hold, never taken for it. An open hold of a
mismatching report (REFERENCE_MISMATCH) is raised, never lowered, when a larger
report of the same provider refund and transaction arrives; if finance already
closed it, a larger report of the same refund opens one new hold (closes only
with `not_this_intent`). Migration 0499 must run before the new build starts
(stop, migrate, start): it adds the `invalid_report` kind.

A refund that is filed or `approved` but not yet sent is held too when a
provider refund report arrives on the same transaction (1077 K1, legend-3aign):
the report could be an echo of that refund, so the intent holds the reported
amount and approving, paying out and requesting a new refund are refused with
`PROVIDER_REFUNDED` (409) until finance closes the hold. Nothing is sent to the
provider while the hold is open, even when the refund and the report together
fit within the amount paid. Before approving, finance checks the provider
dashboard: is the reported refund ours (sent but not yet recorded, for example
after a crash), or a separate refund made there? If it is a separate refund, close the hold with `not_this_intent` (the
only way to close this hold) and then approve the waiting refund; it is paid
once. If the report is our own refund, do not approve it again: cancel the
waiting refund instead, because the provider already paid it. When in doubt,
leave the hold open: the money stays held.

`DOIT_REFUNDS_ENABLED` must have the same value in `api.env` and `worker.env`
(legend-3gna): the API queues approved refunds and the worker pays them, so a
split would queue refunds nobody pays, or pay refunds the API treats as off.
A missing line, `0` and `false` mean off; `1` and `true` mean on. An empty
value (`DOIT_REFUNDS_ENABLED=` or empty quotes) and a bare `DOIT_REFUNDS_ENABLED`
line (no `=` or `:`) are refused, like `env.ts`: write the value out. A trailing
comment counts only after a space and `#`; a TAB before `#` makes the value
invalid.
`deploy/single-vm/check-refund-flag.sh --env-file /absolute/path/compose.env`
compares the two files (no docker, prints only file names). Like Compose, it
lets an exported `API_ENV_FILE` or `WORKER_ENV_FILE` override the path in
`compose.env`; an exported but empty one fails the check. `deploy.sh`
runs it before the first `compose up`: a mismatch stops the deploy before
PostgreSQL starts or anything migrates. The API and the worker also log
`DOIT_REFUNDS_ENABLED` with its resolved value at startup.

A disabled channel is never planned for a recipient: in-app notifications are
still written and the attempt is skipped, never reported as sent. A gap in an
outbox stream (an event whose earlier sequence never arrived) is recorded in
`domain_event_gap_requests` and logged as `Outbox sequence gap`; that aggregate
stays held until the missing event arrives. Watch for that log line: it means a
producer bug, and nothing skips the gap automatically.

Run `deploy/single-vm/deploy.sh --env-file /absolute/path/compose.env --dry-run`
to validate without starting services (it also runs the role wrapper's
`--dry-run`). Without `--dry-run`, it starts PostgreSQL, runs the migration job
once, audits the restricted database roles (`provision-roles.sh --audit`), and
starts the services only if the audit passes. Run only after setting up backup
configuration, provisioning roles and checking the rollout plan. Image
builds and this script do not purchase or provision infrastructure.

### Deployment security checklist

- Restrict origin ports 80 and 443 to current Cloudflare IP ranges; do not
  publish PostgreSQL, API, web, or the local Caddy ask bridge. Docker-published
  ports bypass `ufw`/INPUT rules, so enforce the allowlist in the cloud
  provider's security group or in the `DOCKER-USER` iptables chain, and verify
  from a non-Cloudflare address that 80/443 are refused.
  Use Cloudflare Full (strict) and verify custom-domain issuance and renewal.
- Optional: set the same `SSR_SHARED_SECRET` in `api.env` and `web.env`, and
  `WEB_TRUST_PROXY_HOPS=2` in `web.env` (Cloudflare + Caddy), so the API sees the
  real visitor IP on SSR calls (see Visitor IP from SSR, legend-moe5). Only valid
  with the origin allowlist above, otherwise a direct client can pick its own IP.
- Set `TRUST_PROXY=2` for Cloudflare → Caddy → API and set
  `PUBLIC_RATE_LIMIT_INTERNAL_IPS=172.29.17.10` for this compose network. Ensure
  its subnet does not overlap another network and update both if it changes.
- Set the same long, random `TLS_ASK_TOKEN` for Caddy and API. Keep all secret
  files outside source control and readable only by the intended service.
- Verify forwarding headers, tenant isolation, cache keys by hostname, backup
  restore, alert delivery, and provider wiring in the target environment.
  Never cache authenticated or tenant-specific pages as public responses.
- `deploy/caddy/README.md` describes the local authenticated TLS ask bridge and
  Cloudflare firewall requirements; update the firewall and proxy IP list as
  Cloudflare's ranges change.

Monitoring setup and its limits are documented in `deploy/monitoring/README.md`.
The stack bounds Docker local log retention; arrange external uptime probes and
alert delivery. Device heartbeat, queue and sync-lag alerting require additional
production sources and provider adapters before they can be treated as covered.

### First boot and backup schedule

On a new VM, prepare the private pgBackRest configuration and transport module
before starting application services. Start PostgreSQL, create the migrator login
(next section, before any migration), run the pre-deploy check (see
"Pre-deploy check" below), then run the migration job separately using the
same `--env-file` and Compose file as the deploy script.
Then initialize and check the pgBackRest stanza as the container's `postgres`
user, provision the restricted application and queue roles (next section), and
confirm a successful base backup to both repositories. Provisioning is a
first-boot prerequisite; the deploy script does not perform it. See
`deploy/backup/README.md` for the supplied systemd timer example and
restore-drill procedure. Set `pg1-user` in the private pgBackRest configuration
to the same PostgreSQL login as `POSTGRES_USER` in `compose.env`. Export that
same `POSTGRES_USER` when running the isolated restore drill; its example default
is `replace_me` and must be replaced with the actual login. Once those
prerequisites and the transport adapter are ready, use the deploy script for
subsequent releases.

#### Create the migrator login (legend-jtnd)

Three database roles exist in production:

| Role                                                                     | Attributes                                                                                                                                                    | Used by                                                                                                     |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Bootstrap superuser (`POSTGRES_USER` of the postgres image, compose.env) | SUPERUSER                                                                                                                                                     | Only `provision-roles.sh --migrator`, once at first boot, and break-glass. Never in any service env file.   |
| Migrator `legend_migrator_<16 hex>`, password 48 hex                     | LOGIN NOSUPERUSER BYPASSRLS CREATEROLE NOCREATEDB NOREPLICATION INHERIT, owner of the database (so it is `pg_database_owner` and owns every table it creates) | `MIGRATION_DATABASE_URL` in migrator.env only: migrate, pre-deploy check, provision/audit restricted logins |
| `legend_runtime_*` / `legend_worker_*`                                   | unchanged: NOBYPASSRLS etc.                                                                                                                                   | api/worker                                                                                                  |

The migrator needs `BYPASSRLS` because adding a foreign key to a table with
`FORCE ROW LEVEL SECURITY` validates the existing rows under the tenant policy.
Without it, migrations 0004 and 0063 fail on a fresh database with
`tenant context is required` (legend-jtnd). A superuser in `MIGRATION_DATABASE_URL`
is still accepted by the pre-deploy check, but the documented default is the
dedicated migrator.

Run this once, before the first migration, as the bootstrap superuser:

```sh
deploy/single-vm/provision-roles.sh --env-file /absolute/path/compose.env --migrator
```

The script reads `POSTGRES_USER` and `POSTGRES_PASSWORD` from compose.env and
passes them to the container through the environment, never on a command line.
`MIGRATION_DATABASE_URL` must name a login that matches `legend_migrator_<16 hex>`
with a 48 hex password. Success prints:

```text
Migrator login <name> <created|updated>: owns the database, BYPASSRLS, CREATEROLE, not superuser.
```

The job is idempotent. Re-running it re-keys the password and resets the
attributes above. It refuses, changing nothing, if a relation or schema in
`public`, `app` or `drizzle` is owned by another role. The message names that
role. The database was then migrated by another login. As a superuser, run
`REASSIGN OWNED BY <old> TO <migrator>` and re-run the job. `pgboss` is owned by
the queue login and is not checked.

If the old owner is the bootstrap superuser (oid 10), `REASSIGN OWNED` cannot
move its objects. Run `ALTER ... OWNER TO <migrator>` for each object instead,
or recreate the empty database. The job names the owner role in its refusal.

The job also grants the migrator `ADMIN OPTION, INHERIT FALSE, SET FALSE` on
`legend_app` and on the logins named in `APP_DATABASE_URL` and
`WORKER_DATABASE_URL`, but only when those roles already exist. It does not
grant anything on other roles, including roles that match `legend_runtime_<16 hex>`.

`--migrator` refuses, before Docker starts, a `POSTGRES_USER` or
`POSTGRES_PASSWORD` in compose.env that contains `$`, `\`, or a quote
character. Compose would resolve such a value differently. The error names the
key only, never the value. Use a value without these characters.

### First boot: restricted database roles (legend-zoqc)

The API and worker never receive the migration (administrator) credentials.
They log in with two restricted roles that a one-shot job creates after the
migrations (PRD §3 F3, TEN-02). The migration login is the `legend_migrator_<16 hex>`
login created in the previous section, not the bootstrap superuser.

| Login                     | Env key (file)                                                 | What it can do                                                                                                                                                                                                                                                                          |
| ------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `legend_runtime_<16 hex>` | `APP_DATABASE_URL` (api.env, worker.env; `DATABASE_URL` equal) | Member of `legend_app` only: read and write tenant tables through forced RLS. Not superuser, no `BYPASSRLS`, owns nothing, cannot create or alter objects.                                                                                                                              |
| `legend_worker_<16 hex>`  | `WORKER_DATABASE_URL` (worker.env only)                        | Owns only the `pgboss` queue schema and reads `app.active_tenant_registry`. No access to domain tables.                                                                                                                                                                                 |
| `legend_maint_<16 hex>`   | `MAINTENANCE_DATABASE_URL` (worker.env only, optional here)    | Member of `legend_maintenance` only: no table or sequence rights, runs just `app.audit_retention_due_tenants()` and `app.purge_audit_retention_batch()` (audit retention purge, legend-usyi).                                                                                           |
| `legend_grant_<16 hex>`   | `PAYOUT_GRANTOR_DATABASE_URL` (api.env only, required)         | Member of `legend_payout_grantor` only: no table or sequence rights, runs just `app.payout_grant_issue()` (one-time payout step grants, legend-911). `legend_app` cannot issue a grant.                                                                                                 |
| `legend_reseal_<16 hex>`  | `RESEAL_DATABASE_URL` (worker.env only, optional)              | Only member of `legend_sealed_reseal` (INHERIT, no SET, no ADMIN): no table or sequence rights, runs just `app.reseal_frozen_sealed()` (re-seal of the four frozen sealed columns, legend-qwm9r). `legend_app` and the other logins are not members and cannot `SET ROLE` to the group. |

Both the application login and the queue login get
`idle_in_transaction_session_timeout = '5min'` from the job (legend-9h0kg), so
a stuck session cannot hold back edge sync. Sessions that are already open
keep their old setting until they reconnect, so restart the API and worker after
the job runs. See "Staff device PIN down-sync runbook", rule 3.

1. Generate each login name and password on the VM, and write them into the
   private env files; never commit or paste them anywhere else:

   ```sh
   echo "legend_runtime_$(openssl rand -hex 8)"   # application login name
   echo "legend_worker_$(openssl rand -hex 8)"    # queue login name
   echo "legend_maint_$(openssl rand -hex 8)"     # audit retention login name
   echo "legend_grant_$(openssl rand -hex 8)"     # payout step grant login name
   openssl rand -hex 24                            # a password (one per login)
   ```

   `api.env`: `APP_DATABASE_URL` and `DATABASE_URL` set to
   `postgresql://<app login>:<app password>@postgres:5432/legend`.
   `worker.env`: the same two lines plus `WORKER_DATABASE_URL` with the queue
   login, and `MAINTENANCE_DATABASE_URL` with the audit retention login (same
   host and database; never in `api.env` or `web.env`). The cloud worker refuses
   to start in production without it; the edge worker skips it (follow-up:
   edge audit retention is not scheduled yet). The job provisions it only when
   set, and `--audit` then also verifies that it has no table rights, is not a
   `legend_app` member, and that both retention functions are `SECURITY DEFINER`
   with a pinned `search_path`, owned by the owner of `audit_logs`, and
   executable by neither PUBLIC nor `legend_app`. `migrator.env` alone holds
   `MIGRATION_DATABASE_URL`.

   `api.env` must also set `PAYOUT_GRANTOR_DATABASE_URL` with the payout step
   grant login (same host and database; never in `worker.env` or `web.env`).
   The payout money steps (failed-item correction, overpaid record, return,
   proof closure, posting source) each spend a one-time grant that only this
   login can issue (`app.payout_grant_issue`). The variable is
   required (legend-786te): `provision-roles.sh` and the compose check refuse
   an `api.env` without it, and the API refuses to start in production without
   it, so no deploy can reach the 503 `PAYOUT_STEP_GRANT_UNAVAILABLE` state. `--audit` verifies that the login is a
   member of `legend_payout_grantor` only, has no table or sequence rights, and
   can run no function except `app.payout_grant_issue` (`SECURITY DEFINER`,
   pinned `search_path`, owned by `legend_payout`, not executable by PUBLIC or
   `legend_app`). Treat the URL as a secret: whoever holds it can mint grants
   for finance users who have a live session with fresh MFA. In development
   and test the API falls back to a separate small pool on `DATABASE_URL` and
   issues grants under `SET LOCAL ROLE legend_payout_grantor`.

   `worker.env` may also set `RESEAL_DATABASE_URL` with the frozen-column re-seal
   login (`legend_reseal_<16 hex>`, same host and database; never in `api.env` or
   `web.env`, and never an application, queue, maintenance or migration login).
   The re-seal job reads rows through the normal tenant pool but calls
   `app.reseal_frozen_sealed` through this login only, which has no table rights
   and no `SET` on the group. Without it the job skips the frozen pass without
   failing, still counts the frozen rows as remaining, logs a warning, and the
   old sealing key cannot be retired. The job provisions it only when set, and
   `--audit` then verifies that the login is the only member of
   `legend_sealed_reseal` (`INHERIT`, no `SET`, no `ADMIN OPTION`), that the
   group itself has no table, sequence, `CREATE`, `MAINTAIN`, catalog
   (`pg_authid`, `pg_shadow`) or non-baseline built-in function right, and that
   the function is `SECURITY DEFINER` with a pinned `search_path` and not
   executable by PUBLIC, `legend_app` or any other login. The group audit runs
   even when the variable is unset.

2. Run the job from the private network, on the VM:

   ```sh
   deploy/single-vm/provision-roles.sh --env-file /absolute/path/compose.env --dry-run
   deploy/single-vm/provision-roles.sh --env-file /absolute/path/compose.env
   ```

   The script first refuses to continue if `api.env`, `web.env` or `worker.env`
   contains `MIGRATION_DATABASE_URL`, if `web.env` holds any database URL, if
   `api.env` and `worker.env` disagree on the application login, if a URL is
   not exactly `postgresql://<login>:<48 hex>@host:port/database` (no query
   string), or if the restricted URLs and `MIGRATION_DATABASE_URL` name
   different databases. It also refuses when the shell exports
   `API_ENV_FILE`, `WEB_ENV_FILE`, `WORKER_ENV_FILE` or `MIGRATOR_ENV_FILE`
   with a value other than the one in `compose.env` (Compose would prefer the
   shell's), and pins the checked paths for every Compose call. Any env file
   with a non-ASCII character before a key on some line (a byte-order mark or
   a no-break space, which Compose silently skips, so a hidden
   `MIGRATION_DATABASE_URL` would reach the service) is refused with only the
   line number shown (lines inside a quoted value that spans lines are not
   keys and may hold any text); save such files as plain text. Compose output
   is hidden during validation because Compose echoes an unparsable env line,
   secrets included.

   Those checks read line starts, and Compose reads more: text after a closing
   quote is a new `KEY=value` (`A="x" MIGRATION_DATABASE_URL=...`), and a
   quoted value can span lines and swallow a later line. So, except with
   `--dry-run`, the script also checks the configuration Compose will really
   apply: `docker compose config --format json` is piped straight into
   `deploy/single-vm/check-compose-env.mjs`, run with `node` from the
   migrator image in a container with no network and no env file. It refuses
   unless no service except the two jobs receives `MIGRATION_DATABASE_URL`
   (or `_FILE`), `web` receives no database URL, no service except `worker` receives
   `MAINTENANCE_DATABASE_URL`, no service except `api` receives
   `PAYOUT_GRANTOR_DATABASE_URL`, and the URLs `api` and `worker` receive equal the
   ones just validated. Its messages name only
   services and keys, never values. Compose fills `${VAR}` in env files from
   the shell and `compose.env`, so the configuration is read with the
   environment `deploy.sh` uses to start the services (which never exports
   the URLs); the two validated URLs go to the checker only. `MIGRATOR_IMAGE` must be a plain image reference, and if the
   checker cannot start (image not pulled, no `node`) the script says so and
   stops. `--dry-run` skips this check (it needs the migrator image);
   `deploy.sh` always runs it through `--audit` before any service starts.
   It then starts
   PostgreSQL, applies migrations, and runs the `provision-roles` service (the
   migrator image, `node dist/provision-roles.js`) with `migrator.env` plus the
   two restricted URLs taken from the services' own env files. The URLs reach
   the container through the environment, never a command line.

3. Expect `Restricted database roles are ready.` Only role names are printed.
   Then start the services with `deploy.sh`, which re-checks the roles after
   every migration with `provision-roles.sh --env-file ... --audit`: the same
   checks, changing nothing, plus a sign-in with each URL. If the logins were
   never provisioned, a password no longer matches the env file, or a
   migration widened their rights, the audit fails and no service starts.

The job is idempotent and doubles as an audit: run it again at any time. Each
run, inside one locked transaction, creates a missing login or re-keys an
existing one to the password in the env file (so changing the password there
and re-running is how to rotate it; restart the API and worker afterwards). It
also resets drift that would only break or bend a login (`NOINHERIT`, an
expiry, a connection limit, role-level settings such as `search_path`, a
`legend_app` membership without `INHERIT` or with `ADMIN OPTION`; a superuser
migration login revokes such a grant whoever made it, a non-superuser only its
own, and the job otherwise refuses and names the grantor). Settings a
non-superuser owner cannot reset (for example `session_replication_role`) make
the job fail until a superuser runs `ALTER ROLE ... RESET ALL`. It then
fails, changing nothing, if `legend_app` can log in or has elevated attributes,
or if a login:

- is a superuser or has `BYPASSRLS`, `CREATEDB`, `CREATEROLE` or `REPLICATION`,
  directly or inherited, or inherits any predefined `pg_*` role;
- owns any table, function, type, schema, operator, collation or other
  object outside its own schema (`pgboss`);
- may run a built-in function that `PUBLIC` cannot (such as `pg_read_file`),
  or holds rights on a system catalog beyond `PUBLIC`'s (such as reading
  `pg_authid`);
- can reach, by any path including a grant to `PUBLIC`, an object on the fixed
  sensitive list: `pg_authid`, `pg_shadow`, `pg_user_mapping`, `pg_statistic`,
  `pg_statistic_ext_data`, `pg_largeobject`, `pg_subscription.subconninfo`,
  the file and server functions (`pg_read_file`, `pg_read_binary_file`,
  `pg_ls_dir` and the other `pg_ls_*dir`, `pg_stat_file`, `lo_import`,
  `lo_export`, `pg_reload_conf`, `pg_rotate_logfile`, `pg_promote`) and any
  `dblink*` function. This is an explicit denylist, not a comparison with
  PostgreSQL's default catalog privileges per major version: such a baseline
  would have to be copied and kept for every release, while the denylist is
  short, reviewable and version-independent. Other catalog grants to `PUBLIC`
  are not detected;
- can create objects in the database or any schema outside its own;
- holds, directly, through a group or through `PUBLIC`, `SET` on a parameter
  that is not a plain user setting (such as `session_replication_role`, which
  skips triggers and foreign keys) or on a parameter no loaded module defines
  yet, or `ALTER SYSTEM` on any parameter. As a superuser, remove it with
  `REVOKE SET ON PARAMETER <parameter> FROM <role|PUBLIC>` (or
  `REVOKE ALTER SYSTEM ON PARAMETER ...`) and re-run;
- belongs, directly or through `legend_app`, to any role other than
  `legend_app` (with or without `ADMIN OPTION`; the queue login: to none);
- holds table rights beyond `SELECT/INSERT/UPDATE/DELETE` (application) or
  beyond `SELECT` on `app.active_tenant_registry` (queue), including grants on
  single columns. `TRUNCATE` ignores RLS and is always refused, as are
  `REFERENCES`, `TRIGGER` and, on PostgreSQL 17, `MAINTAIN`. Extension views
  readable by everyone (such as `pg_stat_statements`) are not counted;
  application tables granted to `PUBLIC` are;
- holds sequence rights beyond `USAGE/SELECT` (application) or any sequence
  right outside `pgboss` (queue). `UPDATE` allows `setval()`, which can push a
  sequence to its end and break every insert that uses it;
- would receive such rights on tables or sequences created later through
  default privileges (`ALTER DEFAULT PRIVILEGES`), any default table or
  sequence right granted to `PUBLIC`, or a default `CREATE` on schemas. Remove
  them with `ALTER DEFAULT PRIVILEGES ... REVOKE` and re-run.

The same run (and every audit) also checks tenant isolation itself (TEN-02):
every table with a `tenant_id` column (in `pgboss` only if the application can
reach it, including through a grant on a single column) must have row-level security enabled and forced, and a restrictive
policy for all commands and roles whose `USING` and `WITH CHECK` are exactly
`tenant_id = app.require_tenant_id()`, as `app.enforce_tenant_rls` creates it.
Five tables are documented exceptions, the same list as
`apps/api/src/db/rls.test.ts`: `tenant_domains` and `payment_link_tokens`
(must keep row-level security enabled; reads are open, writes are
tenant-checked: every permissive `INSERT`, `UPDATE`, `DELETE` or `ALL` policy
the application login can use must have `USING` and `WITH CHECK` exactly
`tenant_id = app.require_tenant_id()`, as the migrations create them), and `session`, `login_challenges` and `wa_inbound_messages`
(read before a tenant is known; scoped by the services). A table that fails
the check stops the job. As the migration owner, fix "disabled" with
`ALTER TABLE <table> ENABLE ROW LEVEL SECURITY` and "not forced" with
`ALTER TABLE <table> FORCE ROW LEVEL SECURITY`. For a missing or altered policy,
drop the table's `tenant_access` and `tenant_isolation` policies, then run
`SELECT app.enforce_tenant_rls('<table>'::regclass)` (it creates both and fails
if either exists). Never run it on `tenant_domains` or `payment_link_tokens`:
they only need row-level security enabled. For a write policy on either
reported as "not limited to the tenant", drop it (`DROP POLICY <policy> ON
<table>`), or, if the migrations created it (`tenant_domain_*`,
`payment_link_tokens_*`), restore its expressions with `ALTER POLICY`. The job compares the policy text
with `search_path` set to `pg_catalog`, so a custom `search_path` does not
matter.

After committing, the job signs in with each URL exactly as given and checks
that PostgreSQL reports that login (not a superuser) on the same database. URLs
may carry only TLS and timeout parameters after `?` (`sslmode`, `sslrootcert`,
`sslcert`, `sslkey`, `ssl`, `channel_binding`, `application_name`,
`connect_timeout`); `user`, `password`, `host`, `options` and the like would
override the login and are refused. PostgreSQL 16 or newer is required.

Changing the queue login name: pg-boss keeps its jobs in tables the old login
owns, so the new name must be the same role, renamed. With a new name in
`worker.env` the job stops, creating nothing, with "The pg-boss schema is owned
by <old>, not <new>". As the migration owner run
`ALTER ROLE "<old login>" RENAME TO "<new login>"` (the role keeps its OID, so
it keeps the schema and every table in it), then re-run the job: it re-keys the
password from `worker.env`. Do not create a separate login and move only the
schema: the queue tables would stay with the old role and the worker could not
read them.

An existing role with unsafe attributes is never adopted; fix or drop it by
hand. Passwords are sent to PostgreSQL as SCRAM-SHA-256 verifiers, so the
plaintext never reaches the server or its logs. The migration login must be a
`legend_migrator_<16 hex>` login created in "Create the migrator login"
(`BYPASSRLS`, `CREATEROLE`, owner of the database), or a superuser (the Compose
`POSTGRES_USER`, allowed but not the default). On managed PostgreSQL, use a
`CREATEROLE` + `BYPASSRLS` owner holding `ADMIN` on `legend_app`; existing data
migrations run under forced RLS. With a non-superuser owner the job grants that owner `SET` (never `INHERIT`) on the queue login so it can
hand it the `pgboss` schema.

Outside Compose (another host on the private network, with the API bundle or
the repository), run `node dist/provision-roles.js` or
`pnpm --filter @starter/api exec tsx src/provision-roles.ts` with
`MIGRATION_DATABASE_URL`, `APP_DATABASE_URL`, `WORKER_DATABASE_URL` and
`PAYOUT_GRANTOR_DATABASE_URL` (the payout step grant login) set (and
`MAINTENANCE_DATABASE_URL` for the audit retention login). Each
may instead be supplied as `<NAME>_FILE`, a path to a file holding the URL. The
job does not read `.env` files. Local development keeps using
`pnpm dev:prepare`, which provisions its own random login through the same code.

### Migration lock timeout (legend-jluo)

`deploy.sh` runs the migrations while the previous api and worker still serve. A
migration that needs a strong table lock (`ALTER TABLE`, `NO FORCE ROW LEVEL
SECURITY`, `ADD FOREIGN KEY`) waits behind any long query on that table, and
every new query on it then queues behind the waiting lock, so the old API would
stall for as long as the migration waits. The migrator therefore sets, on its
own session only:

| Variable (migrator.env)       | Default | Meaning                                                                                                   |
| ----------------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `MIGRATION_LOCK_TIMEOUT`      | `10s`   | Longest wait for one lock. `0` waits forever.                                                             |
| `MIGRATION_STATEMENT_TIMEOUT` | `0`     | Longest single statement. `0` (none) overrides any role or database default, so a long backfill finishes. |

Values are `0` or a whole number with `ms`, `s` or `min` (a bare number such as
`10` is refused, since PostgreSQL would read it as milliseconds), at most
`35791min`; anything else stops the migrator before it connects. All pending
migrations run in one transaction, so when a lock is not granted in time the
migrator prints `Migration stopped: a
lock was not granted within MIGRATION_LOCK_TIMEOUT …`, applies nothing,
and exits 1; `deploy.sh` (`set -eu`) then stops before the role audit and the
service restart, and the previous release keeps serving. Retry at a quieter
time, or for that run raise `MIGRATION_LOCK_TIMEOUT` in `migrator.env`.

The limit is per lock wait, not per run: a lock already taken is held until the
whole batch commits. Put a strong lock on a hot table (`outlets`, `employees`,
orders) at the end of its release, after any backfill or index build, so the
services are blocked only for the last statements.

### Pre-deploy check (legend-jtnd, legend-k1np)

`predeploy-check.js` runs before any migration and changes nothing. It opens one
read-only connection with `MIGRATION_DATABASE_URL` and checks two things:

- Migrator: the login is a superuser, or has both `BYPASSRLS` and `CREATEROLE`.
  Otherwise it fails with legend-jtnd.
- Outbox: if `domain_event_outbox` exists, every
  `(tenant_id, destination, aggregate_type, aggregate_id)` group must have
  `min(sequence) = 1` and `max(sequence) = count(*)`. A group that breaks this is
  an old-scheme stream (legend-k1np). The message gives the number of streams and
  the destination names only, never tenant ids or payloads.

Where it runs: `deploy.sh` runs it after `compose up -d --wait postgres` and before
`migrate`. The default mode of `provision-roles.sh` runs it the same way on first
boot. If it fails, `deploy.sh` prints `Pre-deploy check failed: nothing was migrated
and services were not started.` and stops.

Success prints:

```text
Pre-deploy check passed: migrator <user> (<superuser|BYPASSRLS>), outbox <absent|N rows, per-destination sequences intact>.
```

Failure prints `Pre-deploy check failed: <message>` and exits 1. Messages never
contain a URL or password.

What to do when it fails:

- legend-jtnd: create the migrator login with `provision-roles.sh --migrator`
  (see "Create the migrator login"), then re-run the deploy.
- legend-k1np: either write and test a backfill, or confirm the consumers start
  clean and empty the outbox. Do not enable the relay first. The relay must stay
  off until the check passes.

### Gerbang rilis: duplikat langganan sebelum migrasi 0301 (legend-gi697)

Sebelum menjalankan migrasi index langganan, jalankan preflight berikut pada
database target memakai login maintenance/migrator yang
bisa melihat **semua tenant** (superuser atau `BYPASSRLS`). Login aplikasi dengan
RLS dapat menyembunyikan duplikat dan tidak boleh dipakai untuk bukti gerbang.
Nama asli migrasi di `ws/fac07-outbox-events` adalah
`0301_recurring_live_customer_plan_key.sql`; di `milestone/m1` migrasi yang sama
sudah direchain menjadi `0266_recurring_live_customer_plan_key.sql`. Cocokkan
nama dalam paket rilis dengan journal target. Preflight ini tidak memasang atau
mengubah migrasi.

```sh
PGOPTIONS='-c default_transaction_read_only=on -c row_security=off' \
  psql "$MIGRATION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f scripts/preflight/0301-duplicate-subscriptions.sql
```

Query hanya membaca data. Hasilnya satu baris per pasangan
`(tenant_id, plan_id, customer_profile_id)` yang memiliki lebih dari satu
langganan berstatus `pending_first_payment` atau `active`, persis seperti
predikat unique partial index 0301. Hasil menyertakan jumlah, ID lokal, dan ID
langganan provider dalam urutan ID lokal yang sama. Status lain tidak termasuk.
Simpan hasil sebagai bukti operasional terbatas; jangan tempel ID pelanggan atau
provider di log publik.
`row_security=off` membuat query gagal jika RLS akan menyaring baris; opsi ini
tidak mematikan RLS atau memberikan hak `BYPASSRLS` kepada login biasa.

1. **Ada baris atau query gagal: tahan rilis.** Jangan melewati index atau
   menghapus baris untuk memaksa migrasi. Hasil nol baris dari login yang benar
   merupakan syarat gerbang, bukan sekadar exit code `psql` nol.
2. **Resolusi per pasangan.** Operator yang berwenang memeriksa langganan dan
   tagihan di DOIT serta catatan lokal, lalu menentukan langganan yang dipertahankan.
   Batalkan langganan ekstra di gateway terlebih dahulu dan pastikan pembatalan
   sudah dikonfirmasi agar penagihan berikutnya berhenti. Setelah itu, gunakan
   alur rekonsiliasi/pembatalan yang disetujui untuk menandai baris lokal ekstra
   `cancelled`. Pertahankan riwayat dan bukti pembatalan; jangan membatalkan
   pembayaran atau membuat refund otomatis dari hasil preflight ini. Perbedaan
   tagihan yang belum jelas harus diselesaikan operator sebelum rilis.
3. **Cek ulang dan migrasi.** Hentikan sementara permintaan mulai langganan baru
   selama pemeriksaan akhir sampai migrasi selesai agar tidak muncul duplikat
   baru di antara query dan pembuatan index. Jalankan ulang query dengan login
   yang sama; lanjutkan hanya bila hasilnya **nol baris**. Jalankan migrasi
   sesuai prosedur, pastikan index
   `payment_recurring_subscriptions_live_customer_plan_key` berhasil dibuat,
   lalu buka kembali permintaan mulai langganan. Jika migrasi menolak duplikat
   baru, tetap tahan rilis dan ulangi pemeriksaan.

### Gerbang rilis: hold counted tanpa fact terikat (legend-26ro5)

Hold refund lama yang ditutup `counted_against_intent` lewat jalur `rowOf`
sebelum 1126 punya `matched_fact_id` NULL, sehingga refund yang sama bisa
terhitung ganda. Gerbang ini mendaftar hold itu. Berkas
`scripts/preflight/rilis1-legend-26ro5.sql` baca-saja, satu statement `WITH ...
SELECT`, tanpa PII. Runner `release-gates` belum ada di base ini: daftarkan ke
runner saat landing; berkas memakai header runner (`gate`, `before`, `requires`,
`mode: block`, `resolve`). Tabel `refund_recon_holds` belum ada di `main`/`m1`,
jadi pada rilis yang membuat tabel itu gerbang dilewati (`requires-missing`).
Target nyatanya adalah staging atau database yang pernah menjalankan build
cabang sebelum 1126. Untuk dijalankan manual, pakai login yang melihat semua
tenant:

```sh
PGOPTIONS='-c default_transaction_read_only=on -c row_security=off' \
  psql "$MIGRATION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f scripts/preflight/rilis1-legend-26ro5.sql
```

Hasil nol baris = lolos. Satu baris per hold. Kolom `problem`: `fact_unbound`
(hold bernama tanpa fact penyedia yang cocok, atau hold anonim yang bisa
dipasangkan), `fact_below_hold` (JUMLAH fact untuk kuncinya kurang dari hold),
`fact_shared` (fact yang cocok sudah diikat hold lain atau disebut hold counted
lain dengan intent, kind, dan id yang sama). Fact yang diikat atau disebut hold
lain dan fact echo refund kita sendiri tidak dihitung, sama seperti aturan
cakupan 1119. Hold anonim (tanpa refund id) hanya didaftar bila intent-nya
punya fact kind `provider` dan transaksinya masih bersisa. Tidak terdaftar
(sah): hold anonim yang ditutup tanpa fact karena sisa transaksi nol atau
kurang, hold `synthetic_full`, alasan `credit_used_before_provider_refund`, dan
hold anonim yang punya fact `synthetic_hold` miliknya sendiri.

Hold CONFLICT yang ditutup otomatis oleh 1139 tidak dilaporkan `fact_shared`
hanya karena hold lain kemudian diikat ke fact yang sama (rekonsiliasi finance
yang sah): hold `counted_against_intent` dengan alasan CONFLICT, `resolved_by`
kosong, kind `provider`, dan catatan "Otomatis: refund penyedia sudah dicatat
sebagai fakta dan membatasi refund berikutnya" (jalur
`closeFirstPassHoldCoveredByFact`) tetap diperiksa cakupan nominalnya, dan
hold lain yang belum terikat pada kunci yang sama tetap menandainya. Penutupan
otomatis `not_this_intent` tidak pernah menjadi kandidat. Penandanya ketat dan
dicocokkan persis dengan teks service: bila teks service berubah, hold itu
kembali diperlakukan sebagai hold lama (membatasi, bisa memblokir rilis).
Hold yang ditutup finance (`resolved_by` terisi), meski beralasan CONFLICT atau
memakai catatan yang sama, tetap diperlakukan sebagai hold lama.

Keterbatasan gerbang (sengaja dibuat membatasi bila ragu): pencocokan hold
bernama tanpa ref transaksi lebih longgar dari aturan 1119, yang menganggapnya
tidak tercakup apa pun (gerbang mencocokkannya ke fact kunci yang sama di
transaksi mana pun, jadi bisa meloloskan hold yang menurut 1119 belum
tercakup). Sisa transaksi untuk hold anonim disederhanakan dari
`transactionLeftIdr`: refund kita dikurangkan hanya bila hold tanpa transaksi
atau bertransaksi milik intent sendiri, dan cabang dana tak teralokasi tidak
dihitung. Gerbang tidak membedakan hold anonim mana yang sebenarnya dipasangkan
ke fact: semua hold anonim tak terikat pada intent yang punya fact `provider`
dan masih bersisa didaftar, jadi mungkin ada baris yang sebenarnya sah dan
perlu dinilai finance.

**Ada baris atau query gagal: tahan rilis.** Hasil nol baris dari login yang
benar adalah syarat gerbang, bukan sekadar exit code `psql` nol. Tidak ada alur
resolve untuk hold yang sudah tertutup, dan `matched_fact_id` tidak boleh
diubah langsung di database tanpa persetujuan. Remedi yang ada: perbaikan data
sekali pakai yang direview architect dan disetujui CTO dan finance, atau
keputusan CTO mengubah gerbang ke mode `info` setelah run bersih pertama. Tes:
`apps/api/src/test/preflight-rilis1-26ro5.test.ts`.

### Gerbang rilis: akun ganda role kas (legend 1118)

Sebelum rilis yang membawa validasi `CASH_ACCOUNT_SHARED`, jalankan query
read-only berikut pada database target memakai login maintenance/migrator yang
melihat **semua tenant** (superuser atau `BYPASSRLS`). Login aplikasi dengan RLS
dapat menyembunyikan baris dan tidak boleh dipakai untuk bukti gerbang.

```sh
PGOPTIONS='-c default_transaction_read_only=on -c row_security=off' \
  psql "$MIGRATION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f scripts/preflight/1118-shared-cash-mapping.sql
```

File itu berisi empat statement read-only; keempatnya wajib nol baris (atau
dijelaskan finance).

Gerbang yang sama juga dipasang di runner gerbang rilis 1 (legend-gwqjp), yang
otomatis jalan di `predeploy-check`. Runner hanya menerima satu statement per
berkas, jadi keempat statement dibagi menjadi
`scripts/preflight/rilis1-legend-gwqjp1.sql` sampai `gwqjp4.sql` (statement 1
sampai 4, `mode: block`, `before: none` karena validasi `CASH_ACCOUNT_SHARED`
ada di kode aplikasi, bukan migrasi). Berkas `1118-shared-cash-mapping.sql`
tetap untuk run manual lewat `psql`; test
`apps/api/src/test/cash-1118-preflight-sql.test.ts` menjaga isi SQL keduanya
tetap sama. Satu gerbang yang gagal menahan rilis dengan nama `legend-gwqjp<n>`
dan jumlah barisnya; baca penjelasan tiap statement di bawah untuk
resolusinya.

Catatan keputusan (CTO, batch96): gerbang `legend-1tke7` (posting payout GL
legacy tanpa `settle_net_idr`) kini `-- mode: info`: runner hanya mencatat
jumlah barisnya dan tidak menahan rilis. Dari sisi uang ini aman: migrasi 0501
menolak baris dengan net NULL dan cadangannya tetap tertahan, jadi tidak ada
pihak yang dibayar lebih. Finance tetap menyelesaikan baris yang tercatat
sebelum atau sesudah rilis.

Aturan gerbang: baris apa pun = **blokir**. Error query (kolom atau tabel hilang,
skema bergeser) juga = **blokir**: `ON_ERROR_STOP=1` membuat `psql` keluar dengan
kode bukan nol, dan itu tidak boleh dibaca sebagai "nol baris" atau "N/A". Hanya
keluaran nol baris dengan kode keluar 0 yang meloloskan gerbang. Perilaku ini
diuji di `apps/api/src/test/cash-1118-preflight-sql.test.ts`.

**Statement 1: akun ganda.** Satu baris per akun yang dipetakan ke role kas
(`cash_on_hand`, `petty_cash`, `bank`) sekaligus ke role lain, misalnya
`employee_receivable` yang diarahkan ke akun kas kecil 1102. Mapping seperti itu
membuat kasbon tunai menjurnal Dr dan Cr pada akun yang sama, sehingga cadangan
kas terlepas tanpa GL berkurang.

**Statement 2: cadangan yang baru akan ditahan.** Satu baris per kasbon tunai
(`employee_loan.disbursed`, bukan bank) atau reimbursement tunai non-payroll
(`reimbursement.paid`) yang event-nya sudah delivered dan jurnalnya ada, tetapi
kredit bersih (kredit dikurangi debit) pada akun kas jurnal itu lebih kecil
daripada pokoknya, misalnya Dr 1102 / Cr 1102. Akun kas yang diukur adalah
`petty_cash`, `cash_on_hand`, dan `bank` dari `posting_account_snapshot` jurnal;
tanpa snapshot dipakai mapping `petty_cash` saat ini. Setelah rilis, jumlah
pokok tiap baris ini ikut menahan kas kecil (`availableCash1102` berkurang).
Kolom: tenant, entitas hukum, nama event, id kasbon/reimbursement, pokok, dan
kredit bersih. Event delivered tanpa jurnal tidak muncul (cadangannya dilepas
seperti sebelumnya). Entitas hukum di baris dan di penahanan adalah entitas
jurnal itu sendiri (dicari lewat kunci idempotensi), bukan badan usaha karyawan
saat ini: karyawan yang pindah badan usaha tidak melepas jurnal lama yang salah
dari badan usaha lamanya.

**Statement 3: satu akun kas didebit dan dikredit di entri yang sama.** Satu
baris per entri jurnal non-reversal dan per akun kas yang punya baris debit DAN
baris kredit di entri itu, untuk semua jenis aturan: gaji tunai
(`salaries_payable` diarahkan ke 1102), jurnal kas kecil, pengembalian kas kecil
ke bank, kasbon, dan reimburse. Akun kas yang diukur adalah `petty_cash`,
`cash_on_hand`, dan `bank` dari `posting_account_snapshot` entri itu; entri tanpa
snapshot memakai mapping role tersebut hari ini. Kolom: tenant, entitas hukum,
id entri, kunci idempotensi, jenis sumber, akun, total debit, total kredit.
Baris apa pun = blokir.

Risiko yang diterima (architect, 1132):

- **P3-2, penahanan berlipat.** Bila jurnal lama kasbon atau reimburse berupa
  Dr 1101 / Cr 1102, kredit bersih pada gabungan akun kas nol (1101 dan 1102
  sama-sama akun kas), jadi pokoknya ditahan, padahal saldo GL 1102 sudah turun
  oleh kredit itu: kas kecil berkurang dua kali. Arahnya aman: kas yang bisa
  dibayarkan berkurang, tidak pernah bertambah. Finance menjelaskan atau
  membetulkan jurnalnya sebelum rilis.
- **P3-3, jurnal pra-0296 tanpa snapshot.** Jurnal yang dibuat sebelum migrasi
  0296 tidak punya `posting_account_snapshot`, jadi akun kasnya diukur dengan
  mapping hari ini. Bila mapping sudah berpindah sejak jurnal itu dibuat, hasilnya
  bisa menahan terlalu banyak atau terlalu sedikit untuk jurnal tersebut. Diterima
  dan dicatat; baris yang muncul dijelaskan finance.

1. **Ada baris atau query gagal: tahan rilis.** Hasil nol baris dari login yang
   benar adalah syarat gerbang untuk keempat statement, bukan sekadar exit code
   `psql` nol.
2. **Resolusi.** Statement 1: pemilik akuntansi tenant memetakan ulang role
   non-kas ke akun sendiri lewat pengaturan mapping (validasi baru menolak
   sisanya). Jangan mengubah baris `account_mappings` langsung. Statement 2:
   finance memeriksa tiap baris dan memutuskan koreksinya; baris yang dibiarkan
   berarti kas kecil sebesar pokoknya tertahan sampai jurnal dikoreksi, dan
   penahanan itu tidak punya jalan keluar otomatis. Jurnal yang sudah
   terposting tidak dibalik otomatis; keputusan koreksinya di finance.
   Statement 4 (legend 1147): mapping role kas yang akunnya sudah punya jurnal
   dengan snapshot role lain. Finance memeriksa tiap baris; endpoint mapping dan
   impor kini menolak (409 `CASH_MAPPING_ACCOUNT_HAS_HISTORY`) memindahkan role
   kas ke akun berjurnal, jadi baris sisa berasal dari pemetaan yang sudah ada
   sebelum aturan itu. Statement 4 membaca dua bukti: snapshot role di jurnal
   otomatis, dan audit `accounting.account_mappings.replaced` (jurnal tanpa
   snapshot seperti manual, berulang, kas-bank, aset tetap, dan reversal hanya
   terlihat lewat audit). Mapping yang tidak pernah diubah lewat audit dan
   tidak punya jurnal ber-snapshot tidak terlihat gerbang ini; finance memeriksa
   saldo awal akun kas secara manual. Memindahkan role kas ke akun berjurnal,
   termasuk mengembalikan ke akun semula, harus lewat akun baru.
3. **Cek ulang.** Jalankan file yang sama; lanjut hanya bila keempat statement
   nol baris atau barisnya sudah dijelaskan finance.

### Reset refund pra-switch DOIT (legend-d21p)

A one-off repair before `DOIT_REFUNDS_ENABLED` is turned on for the first time.
Builds before 5316426a counted payout attempts on approved refunds that were
never sent to DOIT. `reset-preswitch-refunds.js` puts those refunds back to
"never attempted" and writes one audit row per refund. It runs in the migrator
image with `MIGRATION_DATABASE_URL` (or `MIGRATION_DATABASE_URL_FILE`) from
`migrator.env`, does not read `.env` files, and never prints a URL. Exit codes:
2 for a usage error, 1 for a refused or failed run, 0 for success.

Always run it through `deploy/single-vm/reset-preswitch-refunds.sh`, never
with a raw `docker compose run`. `migrator.env` does not hold
`DOIT_REFUNDS_ENABLED`, so the job cannot see the switch by itself. The wrapper
reads it from `api.env`, `worker.env` and `migrator.env` and from the `api` and
`worker` containers, stopped ones included (a container started before an env
file change still has the old value). It refuses `--apply` unless every one is
absent, `false` or `0` (a bare `DOIT_REFUNDS_ENABLED` line counts as on), when
either service has no container to read, or when the shell exports
`COMPOSE_PROJECT_NAME` with a value other than `compose.env`'s. It passes the
result to the job together with `LEGEND_RESET_WRAPPER=1`. The job's `--apply`
exits 2 when either is missing, so a raw `docker compose run` cannot write.
The wrapper names files and containers only; it never prints their contents or
a URL.

The `--ids` file is on the VM, not in the image. Give the wrapper its absolute
host path: it mounts the file read-only at a fixed path in the container. The
image runs as user `node`, so the file must be readable by all users (for
example mode `0644`); the wrapper refuses it otherwise.

```sh
reset=deploy/single-vm/reset-preswitch-refunds.sh
env=/absolute/path/compose.env
cutoff=2026-11-09T03:00:00Z   # see step (a)
# (b) dry-run
"$reset" --env-file "$env" --dry-run --touched-before "$cutoff"
# (d) apply
"$reset" --env-file "$env" --apply --touched-before "$cutoff" --ids /absolute/path/refund-ids.txt
# (e) check
"$reset" --env-file "$env" --dry-run --touched-before "$cutoff" --ids /absolute/path/refund-ids.txt
```

Run order, per environment:

1. (a) Deploy a build that contains this runner (`dist/reset-preswitch-refunds.js`
   in the migrator image), with `DOIT_REFUNDS_ENABLED` off. The cutoff for
   `--touched-before` is still the start time of the FIRST worker built from
   5316426a or later in that environment, which may be an earlier deploy than
   this one, with its offset, for example
   `2026-11-09T03:00:00Z`. Take it from the deploy record of that first
   deploy; a later redeploy replaces the container, so its own start time is
   too late. When unsure, pick an earlier time: too early is safe (it only
   leaves rows out), too late is not.
2. (b) Dry-run with `--touched-before <cutoff>`. It prints each matching
   refund (tenant, id, amount, decision time) and an id list.
3. (c) Finance review: finance confirms that no listed refund was paid by
   hand. Save only the confirmed ids to a file, one per line (blank lines and
   `#` lines are ignored).
4. (d) Apply with `--apply --touched-before <cutoff> --ids <file>`.
5. (e) Dry-run again with the same `--touched-before` and `--ids`: expect 0
   rows. A plain dry-run must list only the ids finance kept out (paid by
   hand): close each with `POST /api/payments/admin/refunds/<id>/settle-manually`
   (payment.reconcile plus pos.refund.approve, not the requester; it records
   paidAt, channel, transfer reference and amount, ends the refund `completed`
   with `SETTLED_OUTSIDE_PROVIDER` and never pays it out). A dry-run then no
   longer lists them.
6. (f) Only then turn on `DOIT_REFUNDS_ENABLED`.

Read the output of every run. A `SKIPPED refund=<id>` line means a listed id
was not reset (it no longer matches, or it changed during the run), and the
run still exits 0. In step (e), SKIPPED lines for the ids reset in step (d)
are expected: they no longer match because the reset worked. Only rows step
(e) still lists, and SKIPPED lines from step (d) itself, need a decision
before step (f).

`--apply` refuses before any write when the wrapper finds the switch on, when
`DOIT_REFUNDS_ENABLED` is on in the job's environment, or when any refund row
shows the switch was on (a provider ref, pending polls, a DOIT error code, or
a provider decline).
