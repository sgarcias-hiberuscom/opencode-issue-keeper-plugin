export type MetricKind = "read" | "write" | "binary";
export interface MetricLabels { account?: string; kind?: MetricKind }
type MetricKey =
  | "http.requests" | "http.429" | "http.5xx" | "http.errors"
  | "http.latency_ms_sum" | "http.latency_ms_max"
  | "proposals.prepared" | "proposals.applied" | "proposals.rejected" | "proposals.conflict" | "proposals.uncertain";

// Closed enumerations keep the label space low-cardinality: account aliases and
// request kinds only. Ticket text, keys, hashes, paths and IDs are forbidden.
const keys: readonly MetricKey[] = ["http.requests", "http.429", "http.5xx", "http.errors", "http.latency_ms_sum", "http.latency_ms_max",
  "proposals.prepared", "proposals.applied", "proposals.rejected", "proposals.conflict", "proposals.uncertain"];
const kinds: readonly MetricKind[] = ["read", "write", "binary"];

export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly maxima = new Map<string, number>();

  private keyOf(key: MetricKey, labels: MetricLabels): string {
    if (!keys.includes(key)) throw new Error("Métrica no permitida.");
    if (typeof labels !== "object" || labels === null || Array.isArray(labels)) throw new Error("Etiquetas no permitidas.");
    const parts: string[] = [];
    for (const name of ["account", "kind"] as const) {
      const value: string | MetricKind | undefined = labels[name];
      if (value === undefined) continue;
      if (typeof value !== "string" || !value || name === "kind" && !kinds.includes(value as MetricKind)) throw new Error("Etiqueta no permitida.");
      parts.push(`${name}=${value}`);
    }
    if (Object.keys(labels).some((name) => name !== "account" && name !== "kind")) throw new Error("Etiqueta no permitida.");
    return `${key}|${parts.join(",")}`;
  }

  increment(key: MetricKey, labels: MetricLabels = {}, value = 1): void {
    if (!Number.isFinite(value) || value < 0) throw new Error("Valor de métrica no permitido.");
    const compound = this.keyOf(key, labels);
    this.counters.set(compound, (this.counters.get(compound) ?? 0) + value);
  }

  recordLatency(milliseconds: number, labels: MetricLabels = {}): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error("Valor de latencia no permitido.");
    this.increment("http.latency_ms_sum", labels, milliseconds);
    const compound = this.keyOf("http.latency_ms_max", labels);
    this.maxima.set(compound, Math.max(this.maxima.get(compound) ?? 0, milliseconds));
  }

  snapshot(): Record<string, Record<string, number>> {
    const result: Record<string, Record<string, number>> = {};
    for (const compound of [...this.counters.keys(), ...this.maxima.keys()].sort()) {
      const [key, labels] = compound.split("|") as [MetricKey, string];
      const series = result[key] ?? (result[key] = {});
      series[labels] = this.maxima.get(compound) ?? this.counters.get(compound)!;
    }
    return result;
  }

  reset(): void {
    this.counters.clear();
    this.maxima.clear();
  }
}

export const metrics = new Metrics();
