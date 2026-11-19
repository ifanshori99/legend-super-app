# 1203 Backend tukar poin member alur A (engineer Opus, 19 Nov)

Peran: `~/.agents/team/roles/engineer.md`. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore per area, test-writer, implementer per endpoint, architect).
Template kerja: `docs/briefs/_TEMPLATE-workstream.md`. Langkah 0 worktree: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`.
Base: `ws/1165-member-tukar-poin-ui` (748364714; UI alur A + kontrak shared + mock). Cabang: `ws/1203-tukar-poin-backend`. Kartu: legend-0ne0z (+ legend-93f0m bila kunci per entitas menyentuh jalur redeem). Tingkat K (uang: poin = nilai bayar): architect xhigh. Migrasi: 0733-0735 saja.

## Gerbang founder (19 Nov)
Q53 setuju lanjut backend, Q54 warna Petrol (pastikan UI memakai petrol; jangan ubah tata letak yang disetujui). Q52: alur A. Brief UI: `docs/briefs/1165-member-tukar-poin-ui.md`; kebutuhan API ada di laporan thread UI: `ghostex read-session-chat S30:P6b2j:G18iv --grep backend --format text`.

## Lingkup
Endpoint yang dipakai UI (ganti mock): open-bills, points-quote, points-redeem + status, dan cek kepemilikan token member saat mint (token milik member dan tenant yang sama). Ikuti kontrak shared yang sudah ada; perubahan kontrak hanya aditif.

## Aturan uang (jangan rugi)
- Nilai poin yang dipakai tidak boleh melebihi sisa tagihan; saldo poin tidak boleh negatif; redeem idempoten (kunci idempotensi), retry tidak memotong dua kali.
- Quote kedaluwarsa atau saldo berubah: redeem ditolak, bukan disesuaikan diam-diam.
- Batal/void bill sesudah redeem: poin kembali tepat sekali.
- Isolasi tenant dan outlet di SQL. Test membuktikan tidak ada pihak dibayar lebih dan outlet tidak rugi.

## Bukti selesai
Fail-first per aturan di atas (merah di base, hijau sesudah). Test API terarah lewat heavy, test web yang menyentuh hook, text-contract bila ada teks baru. Typecheck api + web sekali lewat heavy, `db:generate` kosong, prettier + eslint. Architect xhigh. Commit, push, tutup kartu. Tunggu job heavy dengan Bash run_in_background satu notifikasi; tanpa Monitor/loop foreground; tanpa laporan antara.

## Laporan
SHA, kartu ditutup, subagent total dan puncak, gate, yang belum teruji. Lapor sekali.
