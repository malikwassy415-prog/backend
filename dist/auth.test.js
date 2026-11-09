import { afterEach, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { buildApp } from "./app.js";
const accessSecret = "test-access-secret-that-is-longer-than-32-bytes";
const refreshSecret = "test-refresh-secret-that-is-longer-than-32-bytes";
function harness() {
    const users = new Map();
    const sessions = new Map();
    let nextId = 1;
    const auth = {
        users: {
            async findUnique({ where }) {
                return [...users.values()].find((u) => (where.email && u.email === where.email) || (where.id && u.id === where.id)) ?? null;
            },
            async create({ data }) {
                const user = { id: `user-${nextId++}`, ...data, createdAt: new Date("2026-01-01T00:00:00.000Z") };
                users.set(user.email, user);
                return user;
            },
        },
        sessions: {
            async get(key) { return sessions.get(key) ?? null; },
            async set(key, value) { sessions.set(key, value); return "OK"; },
            async del(key) { return sessions.delete(key) ? 1 : 0; },
        },
    };
    const appPromise = buildApp({
        health: { db: { query: async () => ({}) }, redis: { ping: async () => "PONG" } },
        auth,
        authEnv: { JWT_ACCESS_SECRET: accessSecret, JWT_REFRESH_SECRET: refreshSecret, NODE_ENV: "test" },
        allowedOrigins: [],
        nodeEnv: "test",
        logger: false,
    });
    return { appPromise, users };
}
describe("authentication", () => {
    const apps = [];
    afterEach(async () => { await Promise.all(apps.splice(0).map(async (p) => (await p).close())); });
    const appFor = (h) => { apps.push(h.appPromise); return h.appPromise; };
    it("registers, logs in, rotates refresh, and logs out", async () => {
        const h = harness();
        const app = await appFor(h);
        const registered = await app.inject({ method: "POST", url: "/auth/register", payload: { email: "Player@Example.test", password: "correct horse battery staple" } });
        expect(registered.statusCode).toBe(201);
        expect(registered.json().user).not.toHaveProperty("passwordHash");
        const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "player@example.test", password: "correct horse battery staple" } });
        expect(login.statusCode).toBe(200);
        expect(login.json().user.role).toBe("PLAYER");
        const cookie1 = String(login.headers["set-cookie"]).split(";")[0];
        expect(String(login.headers["set-cookie"])).toContain("HttpOnly");
        expect(String(login.headers["set-cookie"])).toContain("SameSite=Strict");
        const refresh = await app.inject({ method: "POST", url: "/auth/refresh", headers: { cookie: cookie1 } });
        expect(refresh.statusCode).toBe(200);
        const cookie2 = String(refresh.headers["set-cookie"]).split(";")[0];
        expect(cookie2).not.toBe(cookie1);
        expect((await app.inject({ method: "POST", url: "/auth/refresh", headers: { cookie: cookie1 } })).statusCode).toBe(401);
        expect((await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie: cookie2 } })).statusCode).toBe(204);
        expect((await app.inject({ method: "POST", url: "/auth/refresh", headers: { cookie: cookie2 } })).statusCode).toBe(401);
    });
    it("rejects an incorrect password", async () => {
        const h = harness();
        const app = await appFor(h);
        await app.inject({ method: "POST", url: "/auth/register", payload: { email: "player@example.test", password: "correct horse battery staple" } });
        const result = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "player@example.test", password: "incorrect password" } });
        expect(result.statusCode).toBe(401);
    });
    it("limits the eleventh login attempt in a minute", async () => {
        const h = harness();
        const app = await appFor(h);
        const results = [];
        for (let i = 0; i < 11; i++)
            results.push(await app.inject({ method: "POST", url: "/auth/login", payload: { email: "nobody@example.test", password: "nope" } }));
        expect(results.slice(0, 10).every((r) => r.statusCode === 401)).toBe(true);
        expect(results[10].statusCode).toBe(429);
    });
    it("rejects an expired access token", async () => {
        const h = harness();
        const app = await appFor(h);
        await app.inject({ method: "POST", url: "/auth/register", payload: { email: "player@example.test", password: "correct horse battery staple" } });
        const user = h.users.get("player@example.test");
        const expired = jwt.sign({ sub: user.id }, accessSecret, { algorithm: "HS256", expiresIn: -1 });
        expect((await app.inject({ url: "/auth/me", headers: { authorization: `Bearer ${expired}` } })).statusCode).toBe(401);
    });
    it("blocks players from admin routes", async () => {
        const h = harness();
        const app = await appFor(h);
        await app.inject({ method: "POST", url: "/auth/register", payload: { email: "player@example.test", password: "correct horse battery staple" } });
        const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "player@example.test", password: "correct horse battery staple" } });
        const response = await app.inject({ url: "/admin/protected", headers: { authorization: `Bearer ${login.json().accessToken}` } });
        expect(response.statusCode).toBe(403);
    });
});
