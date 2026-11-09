import { afterEach, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { buildApp } from "./app.js";

const secret = "admin-route-test-secret-with-more-than-32-characters";
const playerId = "4fbf4f9b-cc71-40ec-8e17-d98a11d5c34a";

describe("admin API authorization", () => {
  const apps: Array<Promise<any>> = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map(async (app) => (await app).close())); });

  it("returns 403 to a player on every admin endpoint", async () => {
    const priorSecret = process.env.JWT_ACCESS_SECRET;
    process.env.JWT_ACCESS_SECRET = secret;
    const prisma = {
      user: { findUnique: async () => ({ id: playerId, role: "PLAYER" }) },
    } as any;
    const appPromise = buildApp({
      health: { db: { query: async () => ({}) }, redis: { ping: async () => "PONG" } },
      wallet: prisma,
      logger: false,
      nodeEnv: "test",
    });
    apps.push(appPromise);
    try {
      const app = await appPromise;
      const token = jwt.sign({ sub: playerId }, secret, { algorithm: "HS256", expiresIn: "5m" });
      const headers = { authorization: `Bearer ${token}` };
      const requests = [
        { method: "GET", url: "/admin/users" },
        { method: "GET", url: "/admin/kyc" },
        { method: "GET", url: "/admin/withdrawals" },
        { method: "GET", url: "/admin/audit-logs" },
        { method: "POST", url: `/admin/withdrawals/${playerId}/approve`, payload: { idempotency_key: "test-approve" } },
        { method: "POST", url: `/admin/withdrawals/${playerId}/reject`, payload: { idempotency_key: "test-reject" } },
      ] as const;
      for (const request of requests) {
        const response = await app.inject({ ...request, headers });
        expect(response.statusCode, `${request.method} ${request.url}`).toBe(403);
      }
    } finally {
      if (priorSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
      else process.env.JWT_ACCESS_SECRET = priorSecret;
    }
  });
});
