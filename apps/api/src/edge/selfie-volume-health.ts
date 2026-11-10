// Health of the edge selfie volume (bead legend-svy91; design
// docs/design/hris-edge-replication.md section 5 and 7), shown on
// GET /api/edge/health as `selfieVolume`. Informational only: it never changes
// the health status or HTTP code. It reads directory entries and file sizes and
// modes, never file contents, and returns a state plus byte counts: no paths,
// tenant ids, object ids or personal data.
import { constants } from "node:fs";
import { access, lstat, readdir, statfs } from "node:fs/promises";
import path from "node:path";

export type EdgeSelfieVolumeState =
  "ok" | "missing" | "not_writable" | "loose_permissions";

export interface EdgeSelfieVolumeHealth {
  dir: EdgeSelfieVolumeState;
  /** Bytes available to this process on the volume, null when unknown. */
  freeBytes: number | null;
  /** Bytes in .lss files now, null when the directory cannot be read. */
  usedBytes: number | null;
  /** EDGE_SELFIE_MAX_BYTES. */
  maxBytes: number;
  /** The free space cannot hold what is left of the byte budget. */
  spaceShort: boolean;
}

export interface EdgeSelfieVolumeOptions {
  /** EDGE_SELFIE_DIR. */
  dir: string;
  /** EDGE_SELFIE_MAX_BYTES. */
  maxBytes: number;
}

/** Owner-only: any group or other bit is loose. */
const LOOSE_BITS = 0o077;

type Scan = { loose: boolean; usedBytes: number };

async function scan(dir: string): Promise<Scan> {
  let loose = false;
  let usedBytes = 0;
  for (const tenant of await readdir(dir)) {
    const tenantDir = path.join(dir, tenant);
    const tenantStat = await lstat(tenantDir);
    if (!tenantStat.isDirectory()) continue;
    if (tenantStat.mode & LOOSE_BITS) loose = true;
    let names: string[];
    try {
      names = await readdir(tenantDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".lss")) continue;
      let file;
      try {
        file = await lstat(path.join(tenantDir, name));
      } catch {
        continue; // removed by the sweep or the uploader meanwhile
      }
      if (!file.isFile()) continue;
      if (file.mode & LOOSE_BITS) loose = true;
      usedBytes += file.size;
    }
  }
  return { loose, usedBytes };
}

export async function checkSelfieVolume(
  options: EdgeSelfieVolumeOptions,
): Promise<EdgeSelfieVolumeHealth> {
  const { dir, maxBytes } = options;
  const unusable = (state: EdgeSelfieVolumeState): EdgeSelfieVolumeHealth => ({
    dir: state,
    freeBytes: null,
    usedBytes: null,
    maxBytes,
    spaceShort: false,
  });
  let info;
  try {
    info = await lstat(dir);
  } catch {
    return unusable("missing");
  }
  if (!info.isDirectory()) return unusable("missing");
  try {
    await access(dir, constants.W_OK | constants.X_OK);
  } catch {
    return unusable("not_writable");
  }
  let found: Scan;
  try {
    found = await scan(dir);
  } catch {
    return unusable("not_writable");
  }
  let freeBytes: number | null = null;
  try {
    const fs = await statfs(dir);
    freeBytes = Number(fs.bavail) * Number(fs.bsize);
  } catch {
    freeBytes = null;
  }
  const remaining = Math.max(maxBytes - found.usedBytes, 0);
  return {
    dir: info.mode & LOOSE_BITS || found.loose ? "loose_permissions" : "ok",
    freeBytes,
    usedBytes: found.usedBytes,
    maxBytes,
    spaceShort: freeBytes !== null && freeBytes < remaining,
  };
}

// Health polling must not scan the disk each time: keep the answer 30 s.
const CACHE_MS = 30_000;
let cache: {
  key: string;
  at: number;
  value: Promise<EdgeSelfieVolumeHealth>;
} | null = null;

export function getSelfieVolumeHealth(
  options: EdgeSelfieVolumeOptions,
  now: number = Date.now(),
): Promise<EdgeSelfieVolumeHealth> {
  const key = `${options.dir}\0${options.maxBytes}`;
  if (cache && cache.key === key && now - cache.at < CACHE_MS)
    return cache.value;
  const value = checkSelfieVolume(options);
  cache = { key, at: now, value };
  return value;
}

/** Tests only. */
export function resetSelfieVolumeHealthCache(): void {
  cache = null;
}
