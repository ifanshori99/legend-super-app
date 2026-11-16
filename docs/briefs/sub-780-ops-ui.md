# Brief 780 UI operasional kecil (legend-v4ht, legend-3wyd)

Aturan semua subagent: jangan jalankan tsc/vitest/build/Playwright/pnpm test.
Hanya test node:test terarah lewat `LEGEND_TEST_FILES="tests/x.test.mjs" heavy pnpm test`
jika brief kartumu menyebutnya. Edit hanya berkas milikmu. Jangan sentuh edge sync/API.
Pola test komponen SSR: lihat `tests/platform-offline-banner.test.mjs`
(registerHooks stub + renderToStaticMarkup).

## Kartu A: legend-v4ht (test saja)

`components/ui/segmented-control.tsx` sudah punya `count` (HEAD) dan dipakai
`ws04-kds/components/kds-page.tsx:175`. Tambah `tests/segmented-control-count.test.mjs`:
render SSR; (1) tanpa count tidak ada chip; (2) count 0 tetap tampil "0" (bukan hilang);
(3) count tabular-nums, role radio tetap, nama aksesibel "label count"; (4) selection ink
dan page. Bukti: mutasi sementara (hapus `count !== undefined`) harus menggagalkan test,
lalu kembalikan.

## Kartu B: legend-3wyd (OperationsShell judul layar + slot aksi dari route)

Sekarang `area-frame.tsx:338` memberi shell hanya judul area ("Dapur"). Target:

- Konteks baru `components/shells/operations-screen.tsx`: `OperationsScreenProvider`
  (dipasang AreaFrame di cabang shell operations; menyimpan {title, actions} lewat state),
  hook/komponen `useOperationsScreen({ title, actions })` (daftar di useLayoutEffect
  isomorfik, bersihkan saat unmount). Tanpa provider = no-op (preview/test).
- AreaFrame: `title = screen?.title ?? t(definition.nameKey)`; `actions = [screen?.actions, forcedMode ? null : <ThemeToggle/>]`.
- Layar dapur: KDS `kds-page.tsx:144` h1 visible `kds.title` jadi `sr-only` (jangan
  duplikasi judul shell), judul layar dikirim ke shell. Expo/pickup (`screen-header.tsx`):
  judul ke shell, "diperbarui jam" + tombol Muat ulang pindah ke slot aksi shell; tab
  group (KitchenScreenNav) dan intro tetap di halaman; h1 sr-only tetap.
- Tidak ada teks baru (pakai kunci i18n yang ada) kecuali terpaksa; jika ada, daftarkan di katalog.
- Tampilan 390px: aksi shell sudah wrap (`max-sm:w-full`).
  Bukti: test node:test SSR `tests/operations-screen-slot.test.mjs` yang GAGAL dulu
  (sebelum implementasi): provider+hook mengganti judul shell, tanpa provider tetap judul area.
  Karena efek tidak jalan di SSR, uji logika store/reducer terpisah (fungsi murni) + render
  shell dengan prop title/actions. Jalankan terarah, laporkan hasil gagal lalu lulus.
