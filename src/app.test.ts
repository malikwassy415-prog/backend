import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("API foundation", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  it("reports dependency readiness", async () => {
    const app = await buildApp({ health: { db: { query: async () => ({}) }, redis: { ping: async () => "PONG" } }, allowedOrigins: ["https://play.example"], logger: false });
    close = () => app.close();
    const response = await app.inject({ url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", db: true, redis: true });
  });

  it("returns unavailable when a dependency fails", async () => {
    const app = await buildApp({ health: { db: { query: async () => { throw new Error("down"); } }, redis: { ping: async () => "PONG" } }, logger: false });
    close = () => app.close();
    const response = await app.inject({ url: "/health" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "unavailable", db: false, redis: true });
  });

  it("rejects origins outside the configured allowlist", async () => {
    const app = await buildApp({ health: { db: { query: async () => ({}) }, redis: { ping: async () => "PONG" } }, allowedOrigins: ["https://play.example"], logger: false });
    close = () => app.close();
    const response = await app.inject({ url: "/health", headers: { origin: "https://attacker.example" } });
    expect(response.statusCode).toBe(500);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
