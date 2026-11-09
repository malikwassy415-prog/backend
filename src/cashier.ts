import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { PrismaClient } from "@prisma/client";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { z } from "zod";
import { WalletError, WalletService } from "./wallet.js";

export interface PaymentProvider {
  createDeposit(input: { amount: string; idempotencyKey: string }): Promise<{ externalId: string; status: "SUCCEEDED" }>;
}

/** Local-only payment simulation. It never accepts card data or contacts a processor. */
export class MockPaymentProvider implements PaymentProvider {
  async createDeposit(_input: { amount: string; idempotencyKey: string }) {
    return { externalId: `mock_${randomUUID()}`, status: "SUCCEEDED" as const };
  }
}

const depositSchema = z.object({ amount: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/), idempotency_key: z.string().min(1).max(128) }).strict();
const withdrawSchema = depositSchema;
const webhookSchema = z.object({ external_id: z.string().min(1).max(128), status: z.enum(["SUCCEEDED", "FAILED"]) }).strict();
const approveSchema = z.object({ idempotency_key: z.string().min(1).max(128) }).strict();
const scopedKey = (userId: string, key: string) => createHash("sha256").update(`${userId}:${key}`).digest("hex");

async function currentUser(request: FastifyRequest, reply: FastifyReply, prisma: PrismaClient, admin = false) {
  const secret = process.env.JWT_ACCESS_SECRET;
  const token = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : "";
  let payload: JwtPayload | null = null;
  try {
    if (secret && token) {
      const decoded = jwt.verify(token, secret, { algorithms: ["HS256"] });
      if (typeof decoded !== "string") payload = decoded;
    }
  } catch { /* invalid or expired */ }
  if (!payload?.sub || typeof payload.sub !== "string") {
    await reply.code(401).send({ error: "Unauthorized" });
    return null;
  }
  const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { id: true, role: true } });
  if (!user) { await reply.code(401).send({ error: "Unauthorized" }); return null; }
  if (admin && user.role !== "ADMIN") { await reply.code(403).send({ error: "Forbidden" }); return null; }
  return user;
}

function sendWalletError(reply: FastifyReply, error: unknown) {
  if (error instanceof WalletError) return reply.code(error.statusCode).send({ error: error.message });
  throw error;
}

export async function registerCashierRoutes(app: FastifyInstance, prisma: PrismaClient, provider: PaymentProvider = new MockPaymentProvider()) {
  const wallet = new WalletService(prisma);

  app.post("/cashier/deposit", async (request, reply) => {
    const user = await currentUser(request, reply, prisma);
    if (!user) return reply;
    const parsed = depositSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    try {
      const idempotencyKey = scopedKey(user.id, parsed.data.idempotency_key);
      const original = await wallet.getTransactionResponse(idempotencyKey);
      if (original) return original;
      let intent = await prisma.paymentIntent.findUnique({ where: { idempotencyKey } });
      if (!intent) {
        const payment = await provider.createDeposit({ amount: parsed.data.amount, idempotencyKey });
        intent = await prisma.paymentIntent.create({ data: { userId: user.id, idempotencyKey, externalId: payment.externalId, amount: parsed.data.amount, provider: "MOCK", status: "PENDING" } });
      }
      const response = await wallet.deposit({ userId: user.id, amount: intent.amount.toString(), idempotencyKey: intent.idempotencyKey });
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { status: "SUCCEEDED" } });
      return response;
    } catch (error) { return sendWalletError(reply, error); }
  });

  app.get("/cashier/summary", async (request, reply) => {
    const user = await currentUser(request, reply, prisma);
    if (!user) return reply;
    const walletAccount = await prisma.walletAccount.findUnique({ where: { userId: user.id }, include: { ledgerEntries: { orderBy: { createdAt: "desc" }, take: 50, include: { transaction: true } } } });
    if (!walletAccount) return reply.code(404).send({ error: "Wallet account not found" });
    const [withdrawals, intents] = await Promise.all([
      prisma.withdrawalRequest.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 20 }),
      prisma.paymentIntent.findMany({ where: { userId: user.id }, orderBy: { id: "desc" }, take: 20 }),
    ]);
    const seen = new Set<string>();
    const transactions = walletAccount.ledgerEntries.flatMap((entry) => {
      if (seen.has(entry.transactionId)) return [];
      seen.add(entry.transactionId);
      return [{ id: entry.transaction.id, type: entry.transaction.type, status: entry.transaction.status, created_at: entry.transaction.createdAt, entries: walletAccount.ledgerEntries.filter((row) => row.transactionId === entry.transactionId).map((row) => ({ direction: row.direction, amount: row.amount.toFixed(4), currency: row.currency })) }];
    });
    return { wallet: { real_balance: walletAccount.realBalance.toFixed(4), bonus_balance: walletAccount.bonusBalance.toFixed(4), currency: walletAccount.currency }, transactions, withdrawals, deposits: intents };
  });

  app.get("/responsible-gambling", async (request, reply) => {
    const user = await currentUser(request, reply, prisma); if (!user) return reply;
    const [limits, exclusions] = await Promise.all([prisma.limit.findMany({ where: { userId: user.id } }), prisma.selfExclusion.findMany({ where: { userId: user.id }, orderBy: { until: "desc" }, take: 1 })]);
    return { limits, self_excluded_until: exclusions[0]?.until ?? null };
  });
  app.put("/responsible-gambling/limits", async (request, reply) => {
    const user = await currentUser(request, reply, prisma); if (!user) return reply;
    const schema = z.object({ kind: z.enum(["DEPOSIT", "LOSS", "SESSION"]), period: z.enum(["DAY", "WEEK", "MONTH", "SESSION"]), value: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/) }).strict();
    const parsed = schema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    const existing = await prisma.limit.findFirst({ where: { userId: user.id, kind: parsed.data.kind, period: parsed.data.period } });
    const limit = existing ? await prisma.limit.update({ where: { id: existing.id }, data: { value: parsed.data.value } }) : await prisma.limit.create({ data: { userId: user.id, ...parsed.data } });
    return { limit };
  });
  app.post("/responsible-gambling/self-exclusion", async (request, reply) => {
    const user = await currentUser(request, reply, prisma); if (!user) return reply;
    const parsed = z.object({ enabled: z.boolean(), days: z.number().int().min(1).max(3650).default(365) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    if (!parsed.data.enabled) return { self_excluded_until: null };
    const until = new Date(Date.now() + parsed.data.days * 86_400_000);
    await prisma.selfExclusion.create({ data: { userId: user.id, until } });
    return { self_excluded_until: until };
  });

  app.post("/cashier/deposit/webhook", async (request, reply) => {
    const parsed = webhookSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    const intent = await prisma.paymentIntent.findUnique({ where: { externalId: parsed.data.external_id } });
    if (!intent) return reply.code(404).send({ error: "Deposit intent not found" });
    if (intent.status === "SUCCEEDED") {
      const original = await wallet.getTransactionResponse(intent.idempotencyKey);
      return original ?? { status: "SUCCEEDED" };
    }
    if (parsed.data.status === "FAILED") {
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { status: "FAILED" } });
      return { status: "FAILED" };
    }
    try {
      const response = await wallet.deposit({ userId: intent.userId, amount: intent.amount.toString(), idempotencyKey: intent.idempotencyKey });
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { status: "SUCCEEDED" } });
      return response;
    } catch (error) { return sendWalletError(reply, error); }
  });

  app.post("/cashier/withdraw", async (request, reply) => {
    const user = await currentUser(request, reply, prisma);
    if (!user) return reply;
    const parsed = withdrawSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    try { return await wallet.withdraw({ userId: user.id, amount: parsed.data.amount, idempotencyKey: scopedKey(user.id, parsed.data.idempotency_key) }); }
    catch (error) { return sendWalletError(reply, error); }
  });

  app.post("/admin/withdrawals/:id/approve", async (request, reply) => {
    const user = await currentUser(request, reply, prisma, true);
    if (!user) return reply;
    const parsed = approveSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    const id = (request.params as { id: string }).id;
    if (!z.string().uuid().safeParse(id).success) return reply.code(400).send({ error: "Invalid withdrawal id" });
    try { return await wallet.approveWithdrawal({ withdrawalId: id, adminUserId: user.id, idempotencyKey: scopedKey(user.id, parsed.data.idempotency_key) }); }
    catch (error) { return sendWalletError(reply, error); }
  });
}
