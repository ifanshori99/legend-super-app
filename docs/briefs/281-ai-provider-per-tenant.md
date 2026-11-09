# Brief: engineer (Opus) — WS-12 provider AI OpenAI-compatible per tenant

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/ai-provider-tenant` dari `milestone/m1` (94995dad). Worktree `.worktrees/ai-provider-tenant`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

Nomor migrasi dipesan: `0188`, `when` 1794267000000, satu migrasi.

## Tujuan
`legend-dwrr` (P1, tingkat K: rahasia tenant + akses). Keputusan founder 9 Nov (Q26): tiap tenant mengatur sendiri provider AI lewat kunci API dulu. Jalur OAuth ChatGPT (`legend-z83k`) menyusul; sisakan kolom tipe koneksi untuk adapter itu, jangan bangun OAuth sekarang.

Sudah ada (audit 9 Nov): `apps/api/src/lib/ai/openai-compatible.ts`, `url-guard.ts`, `provider-factory.ts`, `apps/api/src/test/ai-provider.test.ts`, `apps/api/src/lib/secrets.ts`. Kurang:
1. Tabel konfigurasi per tenant: tipe koneksi (`api_key`, cadangan `chatgpt_oauth`), base URL, model default, kunci API terenkripsi (pakai helper enkripsi yang ada bila cocok; bila tidak, keputusan lewat `architect`), status uji terakhir. Pola `tenantIdColumn`, RLS lewat `.custom.sql`.
2. Kontrak dan rute admin: baca (kunci tidak pernah dikirim balik: hanya `hasKey` dan 4 karakter terakhir), simpan atau ganti kunci, hapus, uji koneksi. `requireAuth`, `requireTrustedOrigin`, `requirePermission` untuk admin tenant atau platform.
3. Uji koneksi: lewat `url-guard` (tolak localhost, IP privat, link-local, metadata cloud, redirect ke alamat terlarang), batas waktu, pesan galat tanpa membocorkan kunci.
4. `provider-factory` memakai konfigurasi tenant; `AI_MODEL` global hanya cadangan bila tenant belum mengisi. Anggaran default 0 tetap memblokir panggilan.

Mulai dengan satu subagent `architect` untuk desain (skema, enkripsi, rotasi kunci, izin), catat di `docs/DECISIONS.md`. Sesudah skema masuk, rute dan uji koneksi boleh lewat `implementer` paralel di berkas terpisah.

## Kartu
Awal: `ghostex board associate legend-dwrr`, `bd update legend-dwrr --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa. Buat kartu baru untuk halaman admin UI (butuh mockup, gerbang founder).

## Scope
Boleh: `apps/api/src/lib/ai/*`, schema/service/route konfigurasi AI, migrasi 0188, `packages/shared` bagian AI, `apps/api/src/config/env.ts` bagian AI, test. Jangan: UI web (gerbang mockup), OAuth ChatGPT, fitur AI lain yang memakai provider. Rahasia: hanya nama key dari `.env.example`, jangan baca `.env*`.

## Bukti selesai
- `pnpm db:generate` lalu periksa SQL; generate kedua kosong. Test migrasi RLS (`migration-force-rls-guard`, `migration-fk-force-rls`).
- Test gagal-dulu: kunci tidak muncul di respons, log, maupun galat; tenant A tidak bisa membaca atau mengubah konfigurasi tenant B; peran non-admin ditolak; uji koneksi ke alamat internal dan redirect terlarang ditolak; anggaran 0 memblokir; tenant tanpa konfigurasi memakai cadangan.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file dan tes. Contract root bila `packages/shared` berubah.
- Typecheck api dan shared lewat `heavy` sekali di akhir; eslint + prettier berkas berubah. Jangan `pnpm check` penuh atau `pnpm test` penuh.
- Review (Q48, tingkat K): satu subagent `architect` untuk diff gabungan.
- Tulis brief Codex `docs/briefs/281b-second-opinion-ai-provider.md` (xhigh: rahasia + migrasi), jangan dijalankan.

## Laporan
Sekali di akhir: keputusan desain, SHA, migrasi (`when`, prevId), bukti, file berubah, kontrak untuk UI, kartu baru, risiko, jumlah subagent dan puncak bersamaan.
