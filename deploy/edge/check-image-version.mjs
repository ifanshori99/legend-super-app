// The production edge image must identify the release it actually runs.
const version = process.env.EDGE_NODE_VERSION ?? "";
const parts = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
if (!parts) {
  console.error(
    "EDGE_NODE_VERSION must be a stable semver release (for example 0.2.0).",
  );
  process.exit(1);
}
const [major, minor] = parts.slice(1).map(BigInt);
if (major === 0n && minor < 2n) {
  console.error("EDGE_NODE_VERSION must be at least 0.2.0.");
  process.exit(1);
}
