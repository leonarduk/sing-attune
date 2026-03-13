export interface AudioInputDevice {
  id: number;
  name: string;
}

interface ResolveSelectedDeviceIdArgs {
  devices: AudioInputDevice[];
  defaultDeviceId: number | null;
  persistedDeviceId: number | null;
}

/**
 * Resolve the active input device from persisted, backend default, and available devices.
 *
 * Selection priority:
 * 1. Persisted device (if still present)
 * 2. Backend-reported default (if present)
 * 3. First listed device
 */
export function resolveSelectedDeviceId({
  devices,
  defaultDeviceId,
  persistedDeviceId,
}: ResolveSelectedDeviceIdArgs): number | null {
  const availableIds = new Set(devices.map((device) => device.id));

  if (persistedDeviceId !== null && availableIds.has(persistedDeviceId)) {
    return persistedDeviceId;
  }

  if (defaultDeviceId !== null && availableIds.has(defaultDeviceId)) {
    return defaultDeviceId;
  }

  return devices[0]?.id ?? null;
}
