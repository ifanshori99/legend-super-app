# Brief: engineer (Sonnet) — tombol staf untuk pesanan delivery belum sinkron

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/delivery-staff-resolve` dari `ws/delivery-platform-retry` (2ab2edea, legend-r7vxn; antre merge train). Worktree `.worktrees/delivery-staff-resolve`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge. Tanpa migrasi bila kolom `platform_sync_*` cukup; bila perlu, berhenti dan lapor.

## Tujuan
`legend-eyqvo` (P1). Keputusan founder Q58: pada pesanan `platformSync: needs_action`, staf boleh:
1. Kirim ulang sekali: satu panggilan platform untuk langkah status terakhir yang tertahan, memakai jalur idempoten dan lease yang sama dengan sweep (reference `<orderId>:<status>`, tidak bentrok dengan worker). Sukses: `ok`. Gagal: tetap `needs_action`, tanpa memulai ulang backoff otomatis.
2. Tandai sudah ditangani (staf membereskan di aplikasi mitra): `platformSync` jadi `ok`, intent tertahan ditutup, audit mencatat siapa, kapan, alasan opsional.
- Izin: tambahkan aksi di `packages/shared/src/permissions.ts` (mis. `delivery.order.resolve_sync`) untuk peran outlet yang sudah mengelola pesanan delivery; cakupan outlet; `requireTrustedOrigin`; body strict.
- Konflik: pesanan bukan `needs_action` menjawab 409 dengan kode jelas.

## Kartu
Awal: `ghostex board associate legend-eyqvo`, `bd update legend-eyqvo --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa, dan komentari `legend-u37u3` dengan kontrak endpoint.

## Scope
Boleh: route/service delivery, `delivery-platform-retry.ts`, validator/tipe `packages/shared`, permissions, test. Jangan: payment/refund, pickup/expo, UI.

## Bukti selesai
- Test gagal-dulu: kirim ulang sukses jadi `ok`; gagal tetap `needs_action`; kirim ulang bersamaan dengan sweep tidak mengirim ganda; tandai ditangani tercatat di audit; staf outlet lain dan peran tanpa izin ditolak; pesanan `ok`/`retrying` 409.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file dan tes.
- Typecheck api + shared lewat `heavy` sekali di akhir; eslint + prettier berkas berubah. Jangan `pnpm check` penuh.
- Review (Q48, tingkat K: izin + konkurensi): satu `architect`.

## Laporan
Sekali di akhir: hasil, SHA, migrasi (ada/tidak), bukti, file berubah, kontrak untuk UI, risiko, jumlah subagent dan puncak bersamaan.
