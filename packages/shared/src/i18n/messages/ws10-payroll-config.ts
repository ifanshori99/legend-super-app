// WS-10 payroll configuration: policies, components, BPJS/PTKP/TER tables,
// overtime formula and THR (bead legend-r1bu; PRD v1.7 §3 F30, PAYR-02). Own
// file so parallel WS-10 beads never edit the same catalog lines.
export const payrollConfigMessages = {
  title: "Konfigurasi Payroll",
  nav: {
    config: "Pengaturan Payroll",
  },
} as const;
