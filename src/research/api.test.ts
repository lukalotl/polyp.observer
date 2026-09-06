import { describe, expect, it } from "vitest";
import { researchSocketUrl } from "./api";

describe("research subscriptions behind a static frontend", () => {
  it("keeps a normal workspace's websocket on the page origin", () => {
    expect(researchSocketUrl("http://localhost:5173/workbench", "").href)
      .toBe("ws://localhost:5173/api/research/ws");
    expect(researchSocketUrl("https://polyp.observer/", "").href)
      .toBe("wss://polyp.observer/api/research/ws");
  });

  it("connects a Vercel page directly to its configured HTTPS research VM", () => {
    expect(researchSocketUrl("https://polyp.observer/", "https://research.example.com").href)
      .toBe("wss://research.example.com/api/research/ws");
  });

  it.each([
    "wss://research.example.com",
    "https://user:password@research.example.com",
    "https://research.example.com/other",
    "https://research.example.com/?token=secret",
    "https://research.example.com/#fragment",
  ])("rejects a misconfigured backend origin: %s", (origin) => {
    expect(() => researchSocketUrl("https://polyp.observer/", origin))
      .toThrow("must be an HTTP(S) origin");
  });
});
