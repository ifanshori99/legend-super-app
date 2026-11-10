# Brief lanjutan G998f: kunci rate limit IPv6 per /64

Lanjutan di thread yang sama. Aturan sama dengan brief 265 dan 274.

## Repo
Cabang baru `ws/ipv6-rate-limit-key` dari `ws/auth-audit-trail` (fd953712; antre merge train), worktree `.worktrees/ipv6-rate-limit-key`, `worktree:setup`. Jangan push, jangan merge. Tanpa migrasi.

## Tujuan
`legend-6jgd2` (P2, tingkat K akses). Satu helper kunci IP bersama: IPv4 utuh, IPv6 dinormalkan ke prefiks /64, IPv4-mapped IPv6 (`::ffff:a.b.c.d`) diperlakukan sebagai IPv4. Dipakai oleh `login-challenge-rate-limit.ts`, `public-rate-limit.ts`, dan hitungan IP AUTH-04. Digest IP di audit (`ip_hash`) tidak diubah kecuali memang memakai helper yang sama; sebut di laporan.

## Kartu
Awal: `ghostex board associate legend-6jgd2`, `bd update legend-6jgd2 --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa.

## Bukti selesai
- Test gagal-dulu: dua alamat dalam satu /64 berbagi bucket di ketiga limiter; /64 berbeda tidak; IPv4-mapped sama dengan IPv4; alamat tak valid tidak membuat crash.
- Tes terarah (6 file lama + file baru), sebut jumlah file dan tes. Typecheck api lewat `heavy` sekali; eslint + prettier.
- Review (Q48, tingkat K): satu `architect` untuk diff ini.
- Tambahkan bagian IPv6 ke `docs/briefs/265b-second-opinion-auth-audit.md`.

## Laporan
Sekali di akhir: SHA, bukti, file berubah, risiko, jumlah subagent dan puncak bersamaan.
