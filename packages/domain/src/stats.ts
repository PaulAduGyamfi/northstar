// Small statistics shared by the funnel report (packages/funnel) and the pipeline metrics
// (NS-208), so both use one method.

// The 95% Wilson score interval for k successes in n trials: honest at small n and near 0 or 1,
// where the plain p ± 1.96·se interval goes below zero.
export function wilson(k: number, n: number): [number, number] {
  const z2 = 1.96 ** 2;
  const p = k / n;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (1.96 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}
