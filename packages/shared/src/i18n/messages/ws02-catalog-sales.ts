// Catalog-freshness sales hold text (bead legend-10nex): the notice shown when
// a critical catalog stream is over 24 hours old, the owner override form and
// the promo-off notice. Own file so parallel WS-02 beads never edit the same
// lines in id.ts. Namespace: `catalogSales`. Placeholders: {time}, {until},
// {min}, {max}.

export const catalogSalesMessages = {
  blockedTitle: "Penjualan ditahan: katalog belum tersinkron lebih dari 24 jam",
  blockedHint:
    "Harga dan menu di perangkat ini mungkin sudah tidak sesuai. Minta owner untuk mengizinkan penjualan.",
  unavailableTitle: "Penjualan ditahan: database lokal edge belum bisa dibaca",
  unavailableHint:
    "Hubungi teknisi. Penjualan dibuka lagi otomatis setelah sistem pulih.",
  clockRegressedTitle:
    "Jam perangkat mundur: penjualan ditahan, minta owner mengizinkan",
  clockRegressedHint:
    "Perangkat tidak bisa memastikan katalog masih baru. Minta owner untuk mengizinkan penjualan.",
  taxNotSyncedTitle:
    "Penjualan ditahan: aturan pajak belum tersinkron ke perangkat ini",
  taxNotSyncedHint:
    "Sambungkan perangkat ke internet. Penjualan dibuka otomatis setelah pajak tersinkron.",
  sinceLine: "Terakhir tersinkron sejak {time}.",
  overrideTitle: "Penjualan diizinkan owner sampai {until}",
  overrideHint:
    "Katalog masih belum tersinkron. Penjualan kembali ditahan setelah izin habis, kecuali sinkron berhasil.",
  promoOffNotice:
    "Promo dan voucher dimatikan: data promo belum diperbarui lebih dari 24 jam. Penjualan memakai harga normal.",
  action: "Izinkan penjualan (owner)",
  dialogTitle: "Izinkan penjualan sementara",
  dialogHint:
    "Penjualan berjalan dengan katalog lama. Izin ini tercatat atas nama Anda dan berakhir otomatis.",
  durationLabel: "Lama izin",
  reasonLabel: "Alasan",
  reasonHint: "Contoh: internet toko mati sejak pagi, harga tidak berubah.",
  reasonTooShort: "Alasan minimal {min} karakter.",
  reasonTooLong: "Alasan maksimal {max} karakter.",
  submit: "Izinkan penjualan",
  cancel: "Batal",
  grantFailed:
    "Izin belum tersimpan. Periksa koneksi ke perangkat, lalu coba lagi.",
  grantForbidden: "Hanya owner yang boleh mengizinkan penjualan.",
  granted: "Penjualan diizinkan.",
} as const;
