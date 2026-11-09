# Brief: engineer (Opus) — klaim lintas tenant: nomor WhatsApp dan custom domain

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/tenant-claims` dari `milestone/m1` terbaru (d8ea5e0b atau lebih baru). Worktree `.worktrees/tenant-claims`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

Nomor migrasi dipesan: `0178`, `when` 1794257000000, satu migrasi untuk kedua kartu bila perlu.

Dua kartu, berkas tidak bertumpuk: dua `implementer` paralel sesudah Explore, satu commit per kartu.

## Tujuan
1. `legend-mbd2` (tingkat K, akses antar tenant). Login WhatsApp (legend-v0o) memilih tenant dari konfigurasi `tenant_integrations` whatsapp (`receivingNumber`/`phoneNumberId`). Dua tenant bisa mengisi nomor sama, sehingga challenge satu tenant selesai di nomor tenant lain. Tegakkan keunikan lintas tenant (constraint DB atau indeks ekspresi bila memungkinkan, bukan hanya cek di service; normalisasi nomor E.164). Simpan konfigurasi yang bentrok: 409 dengan kode jelas. Cek data lama yang sudah bentrok: migrasi tidak boleh gagal diam-diam; laporkan cara menanganinya.
2. `legend-t57t` (tingkat K, anti-squat). `tenant_domains.hostname` unik global termasuk baris belum terverifikasi, jadi tenant bisa menyerobot domain tenant lain atau `<slug>.<platform domain>` masa depan. Ubah: keunikan hanya untuk baris terverifikasi (indeks unik parsial), `resolveHost` mengutamakan yang terverifikasi, tolak hostname di bawah platform domain, alur verifikasi DNS (token TXT, endpoint verifikasi; resolver DNS bisa di-mock di test). Baca komentar kartu: sebagian sudah ada di `db/schema/platform-domains.ts:43`.

## Kartu
Awal tiap kartu: `ghostex board associate <id>`, `bd update <id> --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa.

## Scope
Boleh: schema/service/route integrasi tenant dan domain platform, migrasi 0178, validator/tipe `packages/shared`, test. Jangan: Better Auth inti, support session, UI (sebut kontrak baru di laporan).

## Bukti selesai
- `pnpm db:generate` lalu periksa SQL; generate kedua kosong. Test migrasi RLS bila tabel tersentuh.
- Test gagal-dulu: tenant B menyimpan nomor WhatsApp milik A ditolak (termasuk format beda yang sama sesudah normalisasi); dua simpan konkuren hanya satu lolos; domain belum terverifikasi tidak memblokir pemilik sah; hostname di bawah platform domain ditolak; verifikasi TXT benar/salah.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file dan tes.
- Typecheck paket yang berubah lewat `heavy` sekali di akhir; eslint + prettier berkas berubah. Jangan `pnpm check` penuh.
- Review (Q48, tingkat K): satu subagent `architect` untuk diff gabungan.
- Tulis brief Codex `docs/briefs/262b-second-opinion-tenant-claims.md`, jangan dijalankan.

## Laporan
Sekali di akhir: per kartu (hasil, SHA), migrasi (`when`, prevId), bukti, file berubah, kontrak baru untuk UI, risiko, jumlah subagent dan puncak bersamaan.
