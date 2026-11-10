// Test helper (legend-oark): runs `run` as an edge process (static EDGE_MODE
// setting on), then restores the previous value. applyStaffPinRecords refuses
// to run anywhere else.
export async function withEdgeModeEnv<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.EDGE_MODE;
  process.env.EDGE_MODE = "true";
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.EDGE_MODE;
    else process.env.EDGE_MODE = previous;
  }
}
