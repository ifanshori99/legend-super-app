// Navigation labels for the WS-06 inventory/purchasing tab strips (squad
// invfe). The strips are shared by several beads, so their labels live in this
// one file instead of a bead file; bead screens own their own module
// (`ws06-recipe.ts`, `ws06-hpp.ts`, `ws06-suppliers.ts`, `ws06-receiving.ts`).
export const invfeNavMessages = {
  inventory: {
    recipes: "Resep",
    production: "Produksi",
    hpp: "HPP & Food Cost",
  },
  purchasing: {
    documents: "Permintaan & PO",
    suppliers: "Supplier",
    receiving: "Penerimaan",
    invoices: "Faktur & Match",
    returns: "Retur",
    petty: "Pembelian Kecil",
  },
  menu: {
    import: "Impor",
    print: "Cetak",
  },
};
