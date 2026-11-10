/* eslint-disable @typescript-eslint/no-explicit-any */
import { year, type M, type Sc } from "./sim.mts";
let seed = Number(process.argv[2] ?? 7); const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const ri = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const SC: Sc[] = ["gross", "gross_up", "net"];
function month(): M {
  const kind = rnd();
  if (kind < 0.08) return { ln: [], ben: ri(0, 1) ? ri(100_000, 9_000_000) : 0, ded: 0, scheme: SC[ri(0, 2)] };
  const n = ri(1, 3); const ln = Array.from({ length: n }, () => ({ amountIdr: rnd() < 0.15 ? ri(0, 2_000_000) : ri(500_000, 60_000_000), taxScheme: rnd() < 0.6 ? "gross" as Sc : SC[ri(0, 2)] }));
  const cash = ln.reduce((s, l) => s + l.amountIdr, 0); const ded = rnd() < 0.5 ? Math.min(cash, Math.floor(cash * 0.03)) : 0;
  const m: M = { ln, ben: rnd() < 0.5 ? ri(0, 500_000) : 0, ded, scheme: SC[ri(0, 2)] };
  if (rnd() < 0.35) m.ccap = rnd() < 0.3 ? 0 : ri(0, Math.max(0, cash - ded));
  return m;
}
const N = Number(process.argv[3] ?? 3000); let years = 0, periods = 0, withRcv = 0, decRcv = 0, ccapMonths = 0, mixedYears = 0, diffs = 0, throwDiff = 0, refundRcv = 0;
const fails: Record<string, number> = {}; const ex: string[] = [];
for (let i = 0; i < N; i++) {
  const len = rnd() < 0.2 ? ri(1, 11) : 12; const steady = rnd() < 0.5; const base = ri(4_000_000, 40_000_000); const sc0: Sc = rnd() < 0.7 ? "gross" : SC[ri(0, 2)];
  const ms = Array.from({ length: len }, () => steady ? (rnd() < 0.03 ? month() : { ln: [{ amountIdr: base + ri(0, 1_000_000), taxScheme: rnd() < 0.85 ? sc0 : SC[ri(0, 2)] }], ben: ri(0, 1) ? ri(0, 400_000) : 0, ded: ri(0, 1) ? Math.floor(base * 0.03) : 0, scheme: sc0, ...(rnd() < 0.15 ? { ccap: ri(0, base) } : {}) } as M) : month());
  if (rnd() < 0.8) { const t = rnd(); ms[len - 1] = t < 0.3 ? { ln: [], ben: 0, ded: 0, scheme: "gross" } : t < 0.5 ? { ln: [], ben: ri(1, 900_000), ded: 0, scheme: SC[ri(0, 2)] } : { ln: [{ amountIdr: ri(0, 3_000_000), taxScheme: rnd() < 0.7 ? "gross" : SC[ri(0, 2)] }], ben: ri(0, 1) ? ri(0, 300_000) : 0, ded: 0, scheme: SC[ri(0, 2)], ...(rnd() < 0.3 ? { ccap: ri(0, 1_000_000) } : {}) }; }
  const o = { hasTaxId: rnd() < 0.8, partial: rnd() < 0.1, mw: len, noMix: rnd() < 0.1 };
  ccapMonths += ms.filter((m) => m.ccap !== undefined).length;
  const schemes = new Set(ms.flatMap((m) => [m.scheme, ...m.ln.map((l) => l.taxScheme)])); if (schemes.size > 1) mixedYears++;
  for (const al of ["proportional", "gross_first"]) {
    let a: any, b: any, ea = "", eb = "";
    try { a = year("rcv", al, ms, o); } catch (e: any) { ea = String(e.message); }
    try { b = year("prod", al, ms, o); } catch (e: any) { eb = String(e.message); }
    if (ea || eb) { if (ea !== eb) { throwDiff++; if (ex.length < 6) ex.push(`throwdiff ${ea} | ${eb}`); } else fails["throw:" + ea] = (fails["throw:" + ea] ?? 0) + 1; continue; }
    years++; periods += len; if (b.rcvSum + b.dec.R > 0) withRcv++; if (b.dec.R > 0) decRcv++; if (b.rows.some((r: any) => r.eR > 0) && b.rcvSum > 0) refundRcv++;
    const ja = JSON.stringify([a.rows, a.bad, a.open, a.collected]); const jb = JSON.stringify([b.rows, b.bad, b.open, b.collected]);
    if (ja !== jb) { diffs++; if (ex.length < 6) ex.push(`diff ${al} ${JSON.stringify(ms)}`); }
    for (const x of b.bad) { const k = x.replace(/^m\d+ /, ""); fails[k] = (fails[k] ?? 0) + 1; if (ex.length < 6) ex.push(`bad ${al} ${x}`); }
  }
}
console.log({ seed0: process.argv[2], years, periods, withRcv, decRcv, refundWithPriorRcv: refundRcv, ccapMonths, mixedYears, diffs, throwDiff, fails }); ex.forEach((e) => console.log(e));
