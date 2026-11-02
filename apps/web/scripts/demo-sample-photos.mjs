// Demo sample menu photos are mock-only (owner Q17/Q24, legend-4pki). They live
// in `demo/`, outside `public/`, so a normal build never copies them and Nitro's
// asset manifest never lists them. A demo build (VITE_API_MOCK=true) copies
// them into the output so a built demo still carries its photos.
//
// Vite loads .env files itself, so read the same files here instead of trusting
// only the shell environment.
import { cpSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv } from "vite";

const appDir = resolve(import.meta.dirname, "..");
const envDir = resolve(appDir, "../..");
const env = { ...loadEnv("production", envDir, "VITE_"), ...process.env };
const outSample = resolve(appDir, ".output/public/sample");

rmSync(outSample, { recursive: true, force: true });
if (env.VITE_API_MOCK === "true") {
  cpSync(resolve(appDir, "demo/sample"), outSample, { recursive: true });
  console.log("[legend] demo build: copied the sample photos into .output");
}
