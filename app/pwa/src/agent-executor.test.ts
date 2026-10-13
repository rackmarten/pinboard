import { describe, expect, it } from "vitest";
import { AGENT_EXECUTORS, defaultAgentExecutor } from "./api.js";

describe("agent form executor", () => {
  it("defaults a new agent to cli", () => {
    expect(defaultAgentExecutor()).toBe("cli");
    expect(defaultAgentExecutor(null)).toBe("cli");
  });

  it("keeps an existing agent's executor, even one the API no longer accepts", () => {
    expect(defaultAgentExecutor({ executor: "8ball" })).toBe("8ball");
    expect(defaultAgentExecutor({ executor: "api" })).toBe("api");
  });

  it("offers exactly the executors foreman runs, each with a hint", () => {
    expect(AGENT_EXECUTORS.map((e) => e.value)).toEqual(["cli", "cli-host", "8ball"]);
    for (const e of AGENT_EXECUTORS) expect(e.hint).toBeTruthy();
  });
});
