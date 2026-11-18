import { describe, expect, it } from "vitest";
import { Metrics } from "../../src/metrics.js";

describe("[11.4] low-cardinality metrics", () => {
  it("rejects keys and labels outside the closed enumeration", () => {
    const m = new Metrics();
    expect(() => m.increment("http.latency" as never)).toThrow();
    expect(() => m.increment("proposals.applied", { issueKey: "IK-1" } as never)).toThrow();
    expect(() => m.increment("http.requests", { account: "work", kind: "other" as never })).toThrow();
    expect(() => m.increment("http.requests", { account: "" })).toThrow();
    expect(() => m.recordLatency(-1)).toThrow();
  });
  it("accumulates counters and latency per allowed label combination", () => {
    const m = new Metrics();
    m.increment("http.requests", { account: "work", kind: "read" });
    m.increment("http.requests", { account: "work", kind: "read" });
    m.increment("http.requests", { account: "client", kind: "write" });
    m.increment("http.429", { account: "work", kind: "read" });
    m.recordLatency(120, { account: "work", kind: "read" });
    m.recordLatency(80, { account: "work", kind: "read" });
    m.increment("proposals.applied", { account: "work" });
    expect(m.snapshot()).toEqual({
      "http.429": { "account=work,kind=read": 1 },
      "http.latency_ms_max": { "account=work,kind=read": 120 },
      "http.latency_ms_sum": { "account=work,kind=read": 200 },
      "http.requests": { "account=client,kind=write": 1, "account=work,kind=read": 2 },
      "proposals.applied": { "account=work": 1 },
    });
  });
  it("keeps the snapshot stable and independent of insertion order", () => {
    const a = new Metrics();
    a.increment("http.requests", { account: "b" });
    a.increment("http.requests", { account: "a" });
    const b = new Metrics();
    b.increment("http.requests", { account: "a" });
    b.increment("http.requests", { account: "b" });
    expect(Object.keys(a.snapshot()["http.requests"]!)).toEqual(["account=a", "account=b"]);
    expect(a.snapshot()).toEqual(b.snapshot());
  });
  it("reset clears every series", () => {
    const m = new Metrics();
    m.increment("http.requests", { account: "work" });
    m.recordLatency(5, { account: "work" });
    m.reset();
    expect(m.snapshot()).toEqual({});
  });
  it("never accepts high-cardinality identifiers as labels", () => {
    const m = new Metrics();
    for (const label of ["issueKey", "proposalId", "hash", "path", "requestId", "text"]) {
      expect(() => m.increment("http.requests", { [label]: "value" } as never)).toThrow();
    }
  });
});
