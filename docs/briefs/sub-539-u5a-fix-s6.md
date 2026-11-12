# Fix S6 (legend-fzvh) dari review architect

Temuan sedang: draf basi menimpa perubahan admin lain. `account-mappings-page.tsx:183-184` `useState(saved)` dibaca sekali; refetch (staleTime 30 dtk, refetch on focus) mengganti `saved` tapi `draft` tetap → PUT mengirim nilai lama untuk peran yang tidak disentuh. Server tanpa cek konkurensi.

1. mapping-state.ts: `mergeDraftOnto(baseline, draft, latest)` = latest + hanya peran yang di draft berbeda dari baseline.
2. account-mappings-page.tsx:183-220: simpan baseline saat mulai edit; bila saved berubah dan draf belum diubah, reset draf ke saved; saat simpan kirim buildReplaceBody(mergeDraftOnto(baseline, draft, saved)).
3. account-mappings-page.tsx:216-219: 422 → pecah error.message dengan ";" → parseContractIssue → issues per baris.
4. tests/legend-fzvh-account-mappings-ui.test.mjs: test gagal-dulu: user ubah peran A, server ubah peran B → body PUT berisi B baru + A milik user. Jalankan `heavy node --test tests/legend-fzvh-account-mappings-ui.test.mjs`.
