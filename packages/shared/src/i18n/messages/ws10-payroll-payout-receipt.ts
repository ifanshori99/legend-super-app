// WS-10 payout step receipt (legend-7gghu): the notification the worker sends
// to the person whose login attested a payout step. No amount, name or account
// number: the batch total is sealed and the text must not leak it.
export const payrollPayoutReceiptMessages = {
  title: "Langkah pencairan gaji atas nama Anda",
  body: "Anda {verb} {kind} untuk batch gaji periode {period} ({count} item) pada {time} WIB. Bukan Anda? Segera hubungi pemilik usaha dan ganti kata sandi.",
  verb: {
    propose: "mengusulkan",
    approve: "menyetujui",
    record: "mencatat",
    confirm: "mengonfirmasi",
    withdraw: "membatalkan",
  },
  kind: {
    correction: "koreksi gaji",
    overpaid: "pencatatan kelebihan bayar",
    return: "pengembalian dana",
    posting_source: "pengisian sumber jurnal",
    closure: "penutupan bukti",
    resolve: "penyelesaian transfer",
    bank_confirm: "konfirmasi bank",
  },
} as const;
