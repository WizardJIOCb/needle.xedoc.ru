export const HAY_RADIUS = 9.2;
export const HAY_COUNT = 64_000;

export interface HayPoint {
  x: number;
  y: number;
  z: number;
}

export function mulberry32(seed: number): () => number {
  return () => {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function surfaceHeight(x: number, z: number): number {
  const radius = Math.hypot(x, z);
  if (radius >= HAY_RADIUS) return 0;
  const normalized = radius / HAY_RADIUS;
  const mound = 4.7 * Math.pow(1 - normalized * normalized, 0.72);
  const ripple = Math.sin(x * 1.7) * Math.cos(z * 1.4) * 0.11 * (1 - normalized);
  return Math.max(0, mound + ripple);
}

/** The needle is deliberately placed inside the volume, never on its shell. */
export function needlePosition(seed: number): HayPoint {
  const random = mulberry32(seed ^ 0x51e2d);
  const angle = random() * Math.PI * 2;
  const radius = 0.8 + Math.sqrt(random()) * 6.75;
  const x = Math.cos(angle) * radius;
  const z = Math.sin(angle) * radius;
  const ceiling = surfaceHeight(x, z);
  const y = Math.max(0.24, ceiling * (0.2 + random() * 0.48));
  return { x, y, z };
}
