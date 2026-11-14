# 782 — Jalur penerima alarm panik

Basis: `origin/ui/panic-copy-subnav` (`2c60a4bc8`). Lima kartu: `legend-mm029`,
`legend-oi7ub`, `legend-po3fe`, `legend-ewmfd`, `legend-aagpf`. Laporan sumber:
`docs/qa/second-opinion-panic.md` pada worktree laporan `legend-05dc1f32`.

Keputusan implementasi: perbaiki lima akar masalah pada lapisan masing-masing;
pertahankan template izin OM/GM, tenant/outlet/duty checks dan autentikasi perangkat.
Jangan buat kunci produksi palsu, jangan ubah acceptance e2e, jangan merge.
Migrasi hanya jika perlu, slot yang diberikan 0373.

Pembagian file: web recovery PIN; gate fasilitas/darurat/nav; worker adapter dan
provider push; relay cloud-only; recheck receiver session. Test-writer memegang
semua regression test dan satu token heavy. Implementer menunggu bukti merah
sebelum mengubah kode produksi. Review silang dengan konteks segar per area.

Bukti yang diminta: gagal-dulu lalu lulus, enqueue pertama tepat sekali termasuk
replay/folding, pencabutan sesi menutup akses sebelum data lokasi/nama dikirim,
factory produksi memakai subscription valid dan transport terkendali, e2e mock
`legend-jztb7`, typecheck API dan web, ESLint serta Prettier pada file berubah.
Hasil akhirnya commit dan push ke cabang kerja tanpa merge.

## PIN pemulihan penerima (legend-mm029)

Tautan pemulihan membawa `?emergency=true` ke layar PIN. Mode itu hanya memanggil
`POST /api/emergency/sessions` dengan `{ staffUserId: userId, pin }`; tidak
membuka sesi POS atau mengganti token kasir. Respons berhasil berisi
`{ data: { outletId, expiresAt, user: { id, displayName } } }` dan API menerbitkan
cookie HttpOnly `legend_emergency`. Setelah respons berhasil, layar kembali ke
`/fasilitas` agar hook penerima memasang ulang satu socket dan mengambil alert
terbuka. Penolakan perangkat, izin, atau status bertugas tetap tampak sebagai
kegagalan pada layar PIN.

Prasyarat integrasi yang ditemukan: `apiFetch` web belum menyediakan header
`X-Device-Token`, sedangkan API sesi POS maupun darurat memerlukannya. Dialog
pendaftaran perangkat hanya menampilkan token sekali dan sengaja tidak
menyimpannya. Perbaikan ini memakai jalur kredensial yang sudah ada, tidak
menambahkan penyimpanan token browser atau mengganti autentikasi perangkat;
penyediaan header oleh perangkat/deployment tetap perlu dibuktikan terpisah.
