// SAMPLE DATA for /design-system only. Realistic F&B content so components
// render at true length (RYUX RX-AS-03); never shown as real figures, and
// every section that uses it carries a "Contoh data" label. Prices, sales
// totals, and order codes here are illustrative, not Cafe Legend data.
import type { StatusKind } from "@/components/ui/badge";

export const sampleMenu = [
  {
    id: "kopi-susu-gula-aren",
    name: "Kopi Susu Gula Aren",
    description: "Espresso, susu segar, dan gula aren cair.",
    category: "coffee",
    price: 28000,
  },
  {
    id: "matcha-latte",
    name: "Matcha Latte",
    description: "Matcha, susu segar, disajikan dingin atau panas.",
    category: "nonCoffee",
    price: 32000,
  },
  {
    id: "es-teh-leci",
    name: "Es Teh Leci",
    description: "Teh melati dengan buah leci.",
    category: "nonCoffee",
    price: 24000,
  },
  {
    id: "nasi-goreng-kampung",
    name: "Nasi Goreng Rumahan",
    description: "Nasi goreng terasi, telur mata sapi, kerupuk.",
    category: "food",
    price: 45000,
  },
  {
    id: "croissant-mentega",
    name: "Croissant Mentega",
    description: "Croissant panggang harian.",
    category: "food",
    price: 26000,
  },
] as const;

export type SampleOrder = {
  code: string;
  table: string;
  station: string;
  status: Extract<StatusKind, "received" | "preparing" | "ready" | "delivered">;
  total: number;
};

export const sampleOrders: SampleOrder[] = [
  {
    code: "A-0143",
    table: "7",
    station: "Dapur panas",
    status: "received",
    total: 90000,
  },
  {
    code: "A-0142",
    table: "12",
    station: "Bar kopi",
    status: "preparing",
    total: 56000,
  },
  {
    code: "A-0139",
    table: "3",
    station: "Pastry",
    status: "ready",
    total: 52000,
  },
  {
    code: "A-0137",
    table: "15",
    station: "Bar nonkopi",
    status: "delivered",
    total: 1248000,
  },
];

export const sampleTickets = [
  {
    table: "12",
    minutes: 4,
    timer: "onTrack",
    items: ["2× Kopi Susu Gula Aren", "1× Es Teh Leci — kurangi gula"],
  },
  {
    table: "7",
    minutes: 9,
    timer: "near",
    items: ["1× Matcha Latte — panas", "1× Kopi Susu Gula Aren"],
  },
  {
    table: "3",
    minutes: 14,
    timer: "late",
    items: ["2× Kopi Susu Gula Aren — tanpa es"],
  },
] as const;

export const sampleOutlet = "Outlet contoh";
export const sampleStation = "Bar kopi";
export const sampleSalesToday = 18450000;
export const sampleOpenOrders = 23;
export const sampleGuestsToday = 412;
export const sampleTimeZone = "Asia/Jakarta";
