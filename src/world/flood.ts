/**
 * Water level (m relative to sea level) that below-sea-level land floods to
 * once the pumping stations have stopped for this many days. Only the deep
 * polders go under; the rest of the low country just turns marshy.
 */
export function floodLevel(daysSinceCollapse: number): number {
  return -5.5 + Math.min(2.5, daysSinceCollapse * 0.035);
}
