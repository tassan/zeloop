import { describe, expect, it } from "vitest";
import { exponentialBackoff } from "./retry.js";
import type { ZeloopContext } from "./types.js";

const stubCtx = {} as ZeloopContext;

describe("exponentialBackoff", () => {
  it("returns baseMs on attempt 0", () => {
    const policy = exponentialBackoff({ baseMs: 100, maxMs: 10000 });
    expect(policy.nextDelay(0, new Error(), stubCtx)).toBe(100);
  });

  it("doubles delay on each attempt by default", () => {
    const policy = exponentialBackoff({ baseMs: 100, maxMs: 10000 });
    expect(policy.nextDelay(1, new Error(), stubCtx)).toBe(200);
    expect(policy.nextDelay(2, new Error(), stubCtx)).toBe(400);
    expect(policy.nextDelay(3, new Error(), stubCtx)).toBe(800);
  });

  it("caps delay at maxMs", () => {
    const policy = exponentialBackoff({ baseMs: 100, maxMs: 500 });
    expect(policy.nextDelay(5, new Error(), stubCtx)).toBe(500);
    expect(policy.nextDelay(10, new Error(), stubCtx)).toBe(500);
  });

  it("respects custom factor", () => {
    const policy = exponentialBackoff({ baseMs: 100, maxMs: 10000, factor: 3 });
    expect(policy.nextDelay(0, new Error(), stubCtx)).toBe(100);
    expect(policy.nextDelay(1, new Error(), stubCtx)).toBe(300);
    expect(policy.nextDelay(2, new Error(), stubCtx)).toBe(900);
  });

  it("always returns a number (never null)", () => {
    const policy = exponentialBackoff({ baseMs: 100, maxMs: 10000 });
    for (let i = 0; i < 20; i++) {
      const delay = policy.nextDelay(i, new Error(), stubCtx);
      expect(delay).toBeTypeOf("number");
      expect(delay).toBeGreaterThan(0);
    }
  });
});
