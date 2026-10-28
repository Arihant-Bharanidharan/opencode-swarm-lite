/**
 * Model/provider route selection.
 *
 * Contract:
 *   - `score(route) = (quality * 1000) / max(1, latencyMs)`.
 *   - `chooseRoute(routes)` returns the route with the HIGHEST score.
 *   - Ties resolve to the EARLIEST route in the input order.
 *   - An empty list throws.
 */

export interface Route {
  id: string;
  quality: number;
  latencyMs: number;
}

export function score(route: Route): number {
  return (route.quality * 1000) / Math.max(1, route.latencyMs);
}

export function chooseRoute(routes: readonly Route[]): Route {
  if (routes.length === 0) throw new Error("no routes");
  let best = routes[0];
  let bestScore = score(best);
  for (let i = 1; i < routes.length; i++) {
    const s = score(routes[i]);
    if (s < bestScore) {
      best = routes[i];
      bestScore = s;
    }
  }
  return best;
}
