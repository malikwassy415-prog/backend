import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import argon2 from "argon2";
import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { z } from "zod";

const registerSchema = z.object({ email: z.string().email().max(254), password: z.string().min(12).max(128) }).strict();
const loginSchema = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(128) }).strict();
const refreshCookieName = "firstpay_refresh";
const refreshTtlSeconds = 7 * 24 * 60 * 60;

interface UserRecord { id: string; email: string; passwordHash: string; role: "PLAYER" | "ADMIN"; createdAt: Date; }
export interface AuthDependencies {
  users: {
    findUnique(args: { where: { email?: string; id?: string } }): Promise<UserRecord | null>;
    create(args: { data: { email: string; passwordHash: string; role: "PLAYER" } }): Promise<UserRecord>;
  };
  sessions: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, expiryMode: "EX", seconds: number): Promise<unknown>;
    del(key: string): Promise<unknown>;
  };
  wallets?: { create(args: { data: { userId: string } }): Promise<unknown> };
}

function digest(value: string): Buffer { return createHash("sha256").update(value).digest(); }
function matchesDigest(token: string, storedHex: string): boolean {
  const actual = digest(token);
  const expected = Buffer.from(storedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function publicUser(user: UserRecord) { return { id: user.id, email: user.email, role: user.role, createdAt: user.createdAt.toISOString() }; }
function signAccess(user: UserRecord, secret: string): string {
  return jwt.sign({ sub: user.id }, secret, { algorithm: "HS256", expiresIn: "15m" });
}
async function issueRefresh(user: UserRecord, deps: AuthDependencies, secret: string) {
  const jti = randomUUID();
  const token = jwt.sign({ sub: user.id, jti }, secret, { algorithm: "HS256", expiresIn: refreshTtlSeconds });
  await deps.sessions.set(`auth:refresh:${jti}`, digest(token).toString("hex"), "EX", refreshTtlSeconds);
  return token;
}
function setRefreshCookie(reply: FastifyReply, token: string) {
  reply.setCookie(refreshCookieName, token, { httpOnly: true, secure: true, sameSite: "strict", path: "/auth", maxAge: refreshTtlSeconds });
}
function clearRefreshCookie(reply: FastifyReply) {
  reply.clearCookie(refreshCookieName, { httpOnly: true, secure: true, sameSite: "strict", path: "/auth" });
}
function claims(token: string, secret: string): JwtPayload | null {
  try {
    const payload = jwt.verify(token, secret, { algorithms: ["HS256"] });
    return typeof payload === "string" ? null : payload;
  } catch { return null; }
}

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthDependencies, env = process.env) {
  const accessSecret = env.JWT_ACCESS_SECRET;
  const refreshSecret = env.JWT_REFRESH_SECRET;
  if (!accessSecret || !refreshSecret) {
    throw new Error("JWT_ACCESS_SECRET and JWT_REFRESH_SECRET are required");
  }
  if (env.NODE_ENV === "production" && (accessSecret.length < 32 || refreshSecret.length < 32)) {
    throw new Error("Production JWT secrets must each be at least 32 characters");
  }
  await app.register(cookie);

  app.post("/auth/register", { config: { rateLimit: { max: 10, timeWindow: 60_000 } } }, async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    const email = parsed.data.email.toLowerCase();
    const existing = await deps.users.findUnique({ where: { email } });
    if (existing) return reply.code(409).send({ error: "Email already registered" });
    const passwordHash = await argon2.hash(parsed.data.password, { type: argon2.argon2id });
    const user = await deps.users.create({ data: { email, passwordHash, role: "PLAYER" } });
    if (deps.wallets) await deps.wallets.create({ data: { userId: user.id } });
    return reply.code(201).send({ user: publicUser(user) });
  });

  app.post("/auth/login", { config: { rateLimit: { max: 10, timeWindow: 60_000 } } }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    const user = await deps.users.findUnique({ where: { email: parsed.data.email.toLowerCase() } });
    const valid = user ? await argon2.verify(user.passwordHash, parsed.data.password).catch(() => false) : false;
    if (!user || !valid) return reply.code(401).send({ error: "Invalid email or password" });
    const refreshToken = await issueRefresh(user, deps, refreshSecret);
    setRefreshCookie(reply, refreshToken);
    return reply.send({ accessToken: signAccess(user, accessSecret), user: publicUser(user) });
  });

  app.post("/auth/refresh", async (request, reply) => {
    const token = request.cookies[refreshCookieName];
    if (!token) return reply.code(401).send({ error: "Invalid refresh session" });
    const payload = claims(token, refreshSecret);
    if (!payload?.sub || !payload.jti || typeof payload.jti !== "string") return reply.code(401).send({ error: "Invalid refresh session" });
    const key = `auth:refresh:${payload.jti}`;
    const stored = await deps.sessions.get(key);
    if (!stored || !matchesDigest(token, stored)) return reply.code(401).send({ error: "Invalid refresh session" });
    await deps.sessions.del(key);
    const user = await deps.users.findUnique({ where: { id: payload.sub } });
    if (!user) { clearRefreshCookie(reply); return reply.code(401).send({ error: "Invalid refresh session" }); }
    const nextToken = await issueRefresh(user, deps, refreshSecret);
    setRefreshCookie(reply, nextToken);
    return reply.send({ accessToken: signAccess(user, accessSecret), user: publicUser(user) });
  });

  app.post("/auth/logout", async (request, reply) => {
    const token = request.cookies[refreshCookieName];
    if (token) {
      const payload = claims(token, refreshSecret);
      if (payload?.jti && typeof payload.jti === "string") await deps.sessions.del(`auth:refresh:${payload.jti}`);
    }
    clearRefreshCookie(reply);
    return reply.code(204).send();
  });

  const authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<UserRecord | null> => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const payload = token ? claims(token, accessSecret) : null;
    if (!payload?.sub || typeof payload.sub !== "string") {
      await reply.code(401).send({ error: "Unauthorized" });
      return null;
    }
    const user = await deps.users.findUnique({ where: { id: payload.sub } });
    if (!user) { await reply.code(401).send({ error: "Unauthorized" }); return null; }
    return user;
  };

  app.get("/auth/me", async (request, reply) => {
    const user = await authenticate(request, reply);
    return user ? { user: publicUser(user) } : reply;
  });
  app.get("/admin/protected", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return reply;
    if (user.role !== "ADMIN") return reply.code(403).send({ error: "Forbidden" });
    return { status: "ok" };
  });
}

export const authInternals = { refreshCookieName, digest };
