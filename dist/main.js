import { buildApp, createDependencies } from "./app.js";
const dependencies = createDependencies();
const testSessions = new Map();
// Keep local previews usable without requiring a Redis daemon. Production still
// uses Redis for shared sessions and distributed rate limits.
const useMemorySessions = process.env.NODE_ENV !== "production" && /^redis:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(process.env.REDIS_URL ?? "");
const sessions = process.env.NODE_ENV === "test" || useMemorySessions ? {
    get: async (key) => testSessions.get(key) ?? null,
    set: async (key, value) => { testSessions.set(key, value); return "OK"; },
    del: async (key) => Number(testSessions.delete(key)),
} : dependencies.redis;
const app = await buildApp({
    health: { db: dependencies.db, redis: dependencies.redis },
    redisForLimits: process.env.NODE_ENV === "test" || useMemorySessions ? undefined : dependencies.redis,
    auth: { users: dependencies.prisma.user, sessions, wallets: dependencies.prisma.walletAccount },
    wallet: dependencies.prisma,
    games: dependencies.prisma,
});
const shutdown = async () => {
    await app.close();
    await Promise.all([dependencies.db.end(), dependencies.redis.status === "wait" ? Promise.resolve(dependencies.redis.disconnect()) : dependencies.redis.quit(), dependencies.prisma.$disconnect()]);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
try {
    await app.listen({ port: Number(process.env.API_PORT ?? 4000), host: process.env.API_HOST ?? "0.0.0.0" });
}
catch (error) {
    app.log.error(error);
    await shutdown();
    process.exitCode = 1;
}
