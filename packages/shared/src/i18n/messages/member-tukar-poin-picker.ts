// Member tukar poin, slice C: points picker (mockup pilih-poin, poin-kurang).
// Brief 1165, bead legend-0ne0z. id.ts (slice E) mounts it at
// `member.tukarPoin.picker`; components call t("member.tukarPoin.picker.<key>").
export const memberTukarPoinPickerMessages = {
  detailsToggle: "Rincian tagihan dan poin",
  outletArea: "{outlet} · {area}",
  billRef: "Tagihan #{number}",
  billRefTable: "Tagihan #{number} · Meja {table}",
  contextEyebrow: "Tagihan aktif",
  contextTitle: "Cocokkan sebelum lanjut",
  remainingLabel: "Sisa tagihan",
  balanceLabel: "Saldo tersedia",
  balanceValue: "{points} poin",
  eyebrow: "Pakai poin di kasir",
  title: "Berapa poin yang dipakai?",
  rateHint: "{points} poin mengurangi tagihan sebesar {amount}.",
  fieldLabel: "Jumlah poin",
  fieldHint: "Min. {min} · Maks. {max} poin, sesuai saldo dan sisa tagihan.",
  summaryLabel: "Rincian penukaran",
  valueLabel: "Nilai {points} poin",
  remainingAfterLabel: "Sisa bayar setelah dipakai",
  balanceAfterLabel: "Perkiraan sisa poin",
  scopeNote:
    "QR berikutnya hanya untuk tagihan ini dan {points} poin. Poin dipotong setelah penukaran berhasil di kasir.",
  submit: "Buat QR untuk {points} poin",
  submitDisabled: "Buat QR",
  submitting: "Membuat QR…",
  back: "Kembali ke tagihan",
  errorEmpty: "Isi jumlah poin yang ingin dipakai.",
  errorNotInteger: "Isi dengan angka bulat, tanpa titik, koma, atau huruf.",
  errorBelowMin: "Minimal {min} poin.",
  errorOverBalance:
    "Saldo Anda {balance} poin. Kurangi jumlah poin untuk melanjutkan.",
  errorOverBill:
    "Sisa tagihan hanya cukup untuk {max} poin ({amount}). Kurangi jumlah poin untuk melanjutkan.",
  errorNotEligible: "Tagihan ini belum bisa memakai poin.",
};
