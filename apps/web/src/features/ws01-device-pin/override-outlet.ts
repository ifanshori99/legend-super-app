// The outlet an override is filed under (legend-6ew E4). The signed-in staff
// entry carries the outlet their PIN session opened on; an entry saved before
// that was stored has none, so the device's own outlet stands in. With neither,
// the caller must ask for a PIN sign-in again.

function known(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function resolveOverrideOutlet(
  savedOutletId: string | null | undefined,
  deviceOutletId: string | null | undefined,
): string | null {
  return known(savedOutletId) ?? known(deviceOutletId);
}
