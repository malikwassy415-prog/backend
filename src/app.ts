import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { PrismaClient } from "@prisma/client";
import { registerAuthRoutes, type AuthDependencies } from "./auth.js";
import { registerCashierRoutes } from "./cashier.js";
import { registerGameRoutes } from "./games/routes.js";
import { registerAdminRoutes } from "./admin.js";

export interface HealthDependencies {
  db: { query: (sql: string) => Promise<unknown> };
  redis: { ping: () => Promise<unknown> };
}

export interface AppOptions {
  health: HealthDependencies;
  logger?: boolean;
  redisForLimits?: Redis;
  auth?: AuthDependencies;
  wallet?: PrismaClient;
  games?: PrismaClient;
  authEnv?: NodeJS.ProcessEnv;
  allowedOrigins?: string[];
  nodeEnv?: string;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true, genReqId: (req) => req.headers["x-request-id"]?.toString() || crypto.randomUUID() });
  const configuredOrigins = options.allowedOrigins ?? (process.env.ALLOWED_ORIGINS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  const allowedOrigins = new Set([...configuredOrigins, ...((options.nodeEnv ?? process.env.NODE_ENV) === "production" ? [] : ["http://localhost:3000", "http://127.0.0.1:3000"])]);

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"] } },
    hsts: options.nodeEnv === "production" ? { maxAge: 15552000, includeSubDomains: true } : false,
  });
  await app.register(cors, {
    credentials: true,
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      callback(new Error("Origin is not allowed by CORS"), false);
    },
  });
  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: 60_000,
    ...(options.redisForLimits ? { redis: options.redisForLimits } : {}),
  });

  // Fail closed for wagering and money movement unless the deployment opts in.
  // Tests may exercise these flows with isolated fixtures.
  app.addHook("onRequest", async (request, reply) => {
    if (process.env.REAL_MONEY_ENABLED === "true" || (options.nodeEnv ?? process.env.NODE_ENV) === "test") return;
    const path = request.url.split("?", 1)[0];
    const mutatesFunds = request.method === "POST" && (
      path.startsWith("/games/") && !path.startsWith("/games/verify/") ||
      path === "/cashier/deposit" || path === "/cashier/deposit/webhook" ||
      path === "/cashier/withdraw" || /^\/admin\/withdrawals\/[^/]+\/(approve|reject)$/.test(path)
    );
    if (mutatesFunds) return reply.code(503).send({ error: "Real money features are disabled" });
  });

  app.setErrorHandler((error, request, reply) => {
    const errorMessage = error instanceof Error ? error.message : "Request failed";
    request.log.error({ err: error, requestId: request.id }, "request failed");
    const candidateStatus = typeof error === "object" && error !== null && "statusCode" in error ? error.statusCode : undefined;
    const status = typeof candidateStatus === "number" && candidateStatus >= 400 && candidateStatus < 600 ? candidateStatus : 500;
    reply.status(status).send({
      error: status === 500 && (options.nodeEnv ?? process.env.NODE_ENV) === "production" ? "Internal Server Error" : errorMessage,
      requestId: request.id,
    });
  });

  app.get("/health", async (_request, reply) => {
    let db = false;
    let redis = false;
    try { await options.health.db.query("SELECT 1"); db = true; } catch { /* readiness reports dependency state */ }
    try { redis = (await options.health.redis.ping()) === "PONG"; } catch { /* readiness reports dependency state */ }
    const status = db && redis ? 200 : 503;
    return reply.status(status).send({ status: db && redis ? "ok" : "unavailable", db, redis });
  });
  app.get("/health/live", async () => ({ status: "ok" }));

  if (options.auth) await registerAuthRoutes(app, options.auth, options.authEnv);
  else app.get("/auth/ping", { config: { rateLimit: { max: 10, timeWindow: 60_000 } } }, async () => ({ status: "ok" }));
  if (options.wallet) await registerCashierRoutes(app, options.wallet);
  if (options.games) await registerGameRoutes(app, options.games);
  if (options.wallet) await registerAdminRoutes(app, options.wallet);
  return app;
}

export function createDependencies() {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl || !redisUrl) throw new Error("DATABASE_URL and REDIS_URL are required");
  const db = new Pool({ connectionString: databaseUrl });
  const localRedisFallback = process.env.NODE_ENV !== "production" && /^redis:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(redisUrl);
  const redis = new Redis(redisUrl, { lazyConnect: process.env.NODE_ENV === "test" || localRedisFallback, maxRetriesPerRequest: 1 });
  const prisma = new PrismaClient();
  return { db, redis, prisma };
}
