import { describe, it, expect } from "vitest";
import { canTransition, assertTransition } from "../src/utils/state-machine.js";

describe("state machine", () => {
  describe("canTransition", () => {
    it("allows pending → running", () => {
      expect(canTransition("pending", "running")).toBe(true);
    });

    it("allows running → completed", () => {
      expect(canTransition("running", "completed")).toBe(true);
    });

    it("allows running → failed", () => {
      expect(canTransition("running", "failed")).toBe(true);
    });

    it("allows running → paused", () => {
      expect(canTransition("running", "paused")).toBe(true);
    });

    it("allows running → waiting_permission", () => {
      expect(canTransition("running", "waiting_permission")).toBe(true);
    });

    it("allows running → waiting_input", () => {
      expect(canTransition("running", "waiting_input")).toBe(true);
    });

    it("allows running → aborted", () => {
      expect(canTransition("running", "aborted")).toBe(true);
    });

    it("allows paused → running (resume)", () => {
      expect(canTransition("paused", "running")).toBe(true);
    });

    it("allows failed → running (retry)", () => {
      expect(canTransition("failed", "running")).toBe(true);
    });

    it("allows completed → verified", () => {
      expect(canTransition("completed", "verified")).toBe(true);
    });

    it("allows completed → running (restart)", () => {
      expect(canTransition("completed", "running")).toBe(true);
    });

    it("allows waiting_permission → running", () => {
      expect(canTransition("waiting_permission", "running")).toBe(true);
    });

    it("allows waiting_permission → aborted", () => {
      expect(canTransition("waiting_permission", "aborted")).toBe(true);
    });

    it("rejects pending → completed (must go through running)", () => {
      expect(canTransition("pending", "completed")).toBe(false);
    });

    it("rejects completed → pending", () => {
      expect(canTransition("completed", "pending")).toBe(false);
    });

    it("rejects aborted → anything (terminal)", () => {
      expect(canTransition("aborted", "running")).toBe(false);
      expect(canTransition("aborted", "pending")).toBe(false);
    });

    it("rejects verified → anything (terminal)", () => {
      expect(canTransition("verified", "running")).toBe(false);
    });

    it("rejects paused → completed (must resume first)", () => {
      expect(canTransition("paused", "completed")).toBe(false);
    });
  });

  describe("assertTransition", () => {
    it("does not throw for valid transitions", () => {
      expect(() => assertTransition("pending", "running")).not.toThrow();
      expect(() => assertTransition("running", "completed")).not.toThrow();
    });

    it("throws for invalid transitions", () => {
      expect(() => assertTransition("pending", "completed")).toThrow(
        "Invalid state transition: pending → completed"
      );
      expect(() => assertTransition("aborted", "running")).toThrow(
        "Invalid state transition: aborted → running"
      );
    });
  });
});
