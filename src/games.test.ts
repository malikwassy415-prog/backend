import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import jwt from "jsonwebtoken";
import { Prisma, PrismaClient } from "@prisma/client";
import { buildApp } from "./app.js";
import { WalletService } from "./wallet.js";
import { hashServerSeed, hmacDigest, playMines, rouletteOutcome } from "./games/engine.js";

const prisma = new PrismaClient();
const prefix = `game-test-${Date.now()}`;
const secret = "games-test-secret-with-enough-entropy-to-sign";
const created: string[] = [];
let seq = 0;

async function setupPlayer() {
  const user = await prisma.user.create({ data: { email: `${prefix}-${seq++}@example.test`, passwordHash: "integration-test", role: "PLAYER" } });
  created.push(user.id);
  await prisma.walletAccount.create({ data: { userId: user.id, realBalance: "0.0000", currency: "EUR" } });
  const wallet = new WalletService(prisma);
  await wallet.deposit({ userId: user.id, amount: "100.0000", idempotencyKey: `${prefix}-fund-${seq}` });
  const app = await buildApp({ health: { db: { query: async () => ({}) }, redis: { ping: async () => "PONG" } }, games: prisma, logger: false, nodeEnv: "test" });
  const token = jwt.sign({ sub: user.id }, secret, { algorithm: "HS256", expiresIn: "15m" });
  return { user, app, headers: { authorization: `Bearer ${token}` } };
}

describe("provably fair game engines", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for game integration tests");
    process.env.JWT_ACCESS_SECRET = secret;
    const old = await prisma.user.findMany({ where: { email: { startsWith: "game-test-" } }, select: { id: true } });
    for (const user of old) created.push(user.id);
    await cleanup();
    created.length = 0;
  });
  afterAll(async () => { await cleanup(); await prisma.$disconnect(); });

  it("is deterministic for identical server seed, client seed, and nonce", () => {
    const seed = "a".repeat(64);
    expect(rouletteOutcome(seed, "client-1", 42)).toBe(rouletteOutcome(seed, "client-1", 42));
    expect(playMines(seed, "client-1", 42, [1, 2, 3])).toEqual(playMines(seed, "client-1", 42, [1, 2, 3]));
  });

  it("recomputes a completed round outcome from its verification payload", async () => {
    const { app, headers } = await setupPlayer();
    try {
      const commit = await app.inject({ method: "POST", url: "/games/roulette/commit", headers, payload: { client_seed: "verify-client" } });
      expect(commit.statusCode).toBe(201);
      const { round_id, server_seed_hash } = commit.json();
      const resolved = await app.inject({ method: "POST", url: "/games/roulette/resolve", headers, payload: { round_id, amount: "1.0000", idempotency_key: `${prefix}-verify`, bet_type: "red" } });
      expect(resolved.statusCode).toBe(200);
      const verified = await app.inject({ method: "GET", url: `/games/verify/${round_id}` });
      expect(verified.statusCode).toBe(200);
      const payload = verified.json();
      const proof = payload.verification;
      expect(hashServerSeed(proof.server_seed)).toBe(server_seed_hash);
      expect(proof.server_seed_hash).toBe(server_seed_hash);
      const localDigest = createHmac("sha256", proof.server_seed).update(`${proof.client_seed}:${proof.nonce}`).digest();
      expect(localDigest.equals(hmacDigest(proof.server_seed, proof.client_seed, proof.nonce))).toBe(true);
      expect(payload.result.number).toBe(Math.floor(localDigest.readUInt32BE(0) / 0x1_0000_0000 * 37));
    } finally { await app.close(); }
  });

  it("keeps Mines click draws aligned with a fresh replay after two reveals", () => {
    const seed = "b".repeat(64);
    const partial = playMines(seed, "mines-client", 7, [2, 4]);
    const replay = playMines(seed, "mines-client", 7, [2, 4, 6, 8]);
    expect(replay.reveals.slice(0, 2)).toEqual(partial.reveals);
    expect(replay.mine_positions).toEqual(partial.mine_positions);
    expect(replay.reveals[2]?.draw).toBeDefined();
  });

  it("rejects a second resolve and does not debit the wallet twice", async () => {
    const { app, headers, user } = await setupPlayer();
    try {
      const commit = await app.inject({ method: "POST", url: "/games/roulette/commit", headers, payload: { client_seed: "once-client" } });
      const { round_id } = commit.json();
      const body = { round_id, amount: "7.0000", idempotency_key: `${prefix}-once`, bet_type: "red" };
      const first = await app.inject({ method: "POST", url: "/games/roulette/resolve", headers, payload: body });
      expect(first.statusCode).toBe(200);
      const balanceAfterFirst = await prisma.walletAccount.findUniqueOrThrow({ where: { userId: user.id } });
      const second = await app.inject({ method: "POST", url: "/games/roulette/resolve", headers, payload: body });
      expect(second.statusCode).toBe(409);
      const balanceAfterSecond = await prisma.walletAccount.findUniqueOrThrow({ where: { userId: user.id } });
      expect(balanceAfterSecond.realBalance.equals(balanceAfterFirst.realBalance)).toBe(true);
      const betTx = await prisma.transaction.findUnique({ where: { idempotencyKey: `${user.id}:game:${round_id}:bet` } });
      expect(betTx).not.toBeNull();
      const ledgerCount = await prisma.ledgerEntry.count({ where: { transactionId: betTx!.id } });
      expect(ledgerCount).toBe(2);
    } finally { await app.close(); }
  });
});

async function cleanup() {
  for (const userId of created.splice(0)) {
    const rounds = await prisma.gameRound.findMany({ where: { userId }, select: { id: true } });
    const roundIds = rounds.map((round) => round.id);
    const txs = await prisma.transaction.findMany({ where: { OR: [{ idempotencyKey: { startsWith: prefix } }, ...roundIds.flatMap((id) => [{ idempotencyKey: `${userId}:game:${id}:bet` }, { idempotencyKey: `${userId}:game:${id}:win` }])] }, select: { id: true } });
    const wallet = await prisma.walletAccount.findUnique({ where: { userId }, select: { id: true } });
    await prisma.ledgerEntry.deleteMany({ where: { OR: [{ transactionId: { in: txs.map((tx) => tx.id) } }, ...(wallet ? [{ accountId: wallet.id }] : [])] } });
    await prisma.transaction.deleteMany({ where: { id: { in: txs.map((tx) => tx.id) } } });
    await prisma.seedCommitment.deleteMany({ where: { roundId: { in: roundIds } } });
    await prisma.bet.deleteMany({ where: { roundId: { in: roundIds } } });
    await prisma.gameRound.deleteMany({ where: { id: { in: roundIds } } });
    await prisma.walletAccount.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
}
