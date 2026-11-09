import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { buildApp } from "./app.js";
import { WalletService } from "./wallet.js";

const prisma = new PrismaClient();
const createdUserIds: string[] = [];
const prefix = `wallet-test-${Date.now()}`;
let sequence = 0;
const nextKey = (label: string) => `${prefix}-${label}-${sequence++}`;

async function createPlayer() {
  const user = await prisma.user.create({ data: { email: `${prefix}-${sequence++}@example.test`, passwordHash: "test-hash", role: "PLAYER" } });
  createdUserIds.push(user.id);
  await prisma.walletAccount.create({ data: { userId: user.id, realBalance: "0.0000", bonusBalance: "0.0000", currency: "EUR" } });
  return user;
}

async function entriesForKeys(keys: string[]) {
  const transactions = await prisma.transaction.findMany({ where: { idempotencyKey: { in: keys } }, select: { id: true, idempotencyKey: true } });
  const entries = await prisma.ledgerEntry.findMany({ where: { transactionId: { in: transactions.map((t) => t.id) } } });
  return { transactions, entries };
}

function expectBalanced(entries: Array<{ amount: Prisma.Decimal; direction: string }>) {
  const signed = entries.reduce((sum, entry) => sum.plus(entry.direction === "CREDIT" ? entry.amount : entry.amount.negated()), new Prisma.Decimal(0));
  expect(signed.equals(0)).toBe(true);
}

describe("wallet ledger", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for wallet integration tests");
    const staleUsers = await prisma.user.findMany({ where: { email: { startsWith: "wallet-test-" } }, select: { id: true } });
    if (!staleUsers.length) return;
    const staleUserIds = staleUsers.map((user) => user.id);
    const staleWallets = await prisma.walletAccount.findMany({ where: { userId: { in: staleUserIds } }, select: { id: true } });
    const staleTransactions = await prisma.transaction.findMany({ where: { idempotencyKey: { startsWith: "wallet-test-" } }, select: { id: true } });
    await prisma.ledgerEntry.deleteMany({ where: { OR: [{ transactionId: { in: staleTransactions.map((row) => row.id) } }, { accountId: { in: staleWallets.map((wallet) => wallet.id) } }] } });
    await prisma.transaction.deleteMany({ where: { id: { in: staleTransactions.map((row) => row.id) } } });
    await prisma.paymentIntent.deleteMany({ where: { userId: { in: staleUserIds } } });
    await prisma.withdrawalRequest.deleteMany({ where: { userId: { in: staleUserIds } } });
    await prisma.bet.deleteMany({ where: { round: { userId: { in: staleUserIds } } } });
    await prisma.gameRound.deleteMany({ where: { userId: { in: staleUserIds } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: staleUserIds } } });
    await prisma.walletAccount.deleteMany({ where: { userId: { in: staleUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: staleUserIds } } });
  });
  afterEach(async () => {
    for (const userId of createdUserIds.splice(0)) {
      const txs = await prisma.transaction.findMany({ where: { idempotencyKey: { startsWith: prefix } }, select: { id: true } });
      const wallet = await prisma.walletAccount.findUnique({ where: { userId }, select: { id: true } });
      await prisma.ledgerEntry.deleteMany({ where: { OR: [{ transactionId: { in: txs.map((t) => t.id) } }, ...(wallet ? [{ accountId: wallet.id }] : [])] } });
      await prisma.transaction.deleteMany({ where: { id: { in: txs.map((t) => t.id) } } });
      await prisma.auditLog.deleteMany({ where: { actorId: userId } });
      await prisma.paymentIntent.deleteMany({ where: { userId } });
      await prisma.withdrawalRequest.deleteMany({ where: { userId } });
      await prisma.bet.deleteMany({ where: { round: { userId } } });
      await prisma.gameRound.deleteMany({ where: { userId } });
      await prisma.walletAccount.deleteMany({ where: { userId } });
      await prisma.user.delete({ where: { id: userId } });
    }
  });
  afterAll(async () => prisma.$disconnect());

  it("records a full bet then win cycle with balanced ledger entries", async () => {
    const user = await createPlayer();
    const service = new WalletService(prisma);
    const depositKey = nextKey("deposit");
    const betKey = nextKey("bet");
    const winKey = nextKey("win");
    await service.deposit({ userId: user.id, amount: "100.0000", idempotencyKey: depositKey });
    await service.bet({ userId: user.id, amount: "20.0000", idempotencyKey: betKey });
    await service.win({ userId: user.id, amount: "36.0000", idempotencyKey: winKey });
    const { transactions, entries } = await entriesForKeys([depositKey, betKey, winKey]);
    expect(transactions).toHaveLength(3);
    expect(entries).toHaveLength(6);
    for (const transaction of transactions) {
      const rows = entries.filter((entry) => entry.transactionId === transaction.id);
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expectBalanced(rows);
    }
  });

  it("credits exactly once when the same deposit webhook is replayed ten times", async () => {
    const user = await createPlayer();
    const idempotencyKey = nextKey("webhook");
    const externalId = `mock_${nextKey("external")}`;
    await prisma.paymentIntent.create({ data: { userId: user.id, idempotencyKey, externalId, amount: "17.2500", provider: "MOCK", status: "PENDING" } });
    const app = await buildApp({ health: { db: { query: async () => ({}) }, redis: { ping: async () => "PONG" } }, wallet: prisma, nodeEnv: "test", logger: false });
    try {
      const responses = [];
      for (let replay = 0; replay < 10; replay++) responses.push(await app.inject({ method: "POST", url: "/cashier/deposit/webhook", payload: { external_id: externalId, status: "SUCCEEDED" } }));
      expect(responses.every((response) => response.statusCode === 200)).toBe(true);
      const wallet = await prisma.walletAccount.findUniqueOrThrow({ where: { userId: user.id } });
      expect(wallet.realBalance.equals(new Prisma.Decimal("17.2500"))).toBe(true);
      const { transactions, entries } = await entriesForKeys([idempotencyKey]);
      expect(transactions).toHaveLength(1);
      expect(entries).toHaveLength(2);
      expectBalanced(entries);
    } finally { await app.close(); }
  });

  it("keeps withdrawals pending until admin approval debits the wallet", async () => {
    const user = await createPlayer();
    const admin = await prisma.user.create({ data: { email: `${prefix}-admin@example.test`, passwordHash: "test-hash", role: "ADMIN" } });
    createdUserIds.push(admin.id);
    const service = new WalletService(prisma);
    await service.deposit({ userId: user.id, amount: "100.0000", idempotencyKey: nextKey("funds") });
    const requestKey = nextKey("withdraw");
    const request = await service.withdraw({ userId: user.id, amount: "30.0000", idempotencyKey: requestKey });
    expect(request.status).toBe("PENDING");
    let wallet = await prisma.walletAccount.findUniqueOrThrow({ where: { userId: user.id } });
    expect(wallet.realBalance.equals(new Prisma.Decimal("100.0000"))).toBe(true);
    const withdrawal = await prisma.withdrawalRequest.findFirstOrThrow({ where: { userId: user.id } });
    const approval = await service.approveWithdrawal({ withdrawalId: withdrawal.id, adminUserId: admin.id, idempotencyKey: nextKey("approve") });
    expect(approval.status).toBe("APPROVED");
    wallet = await prisma.walletAccount.findUniqueOrThrow({ where: { userId: user.id } });
    expect(wallet.realBalance.equals(new Prisma.Decimal("70.0000"))).toBe(true);
  });

  it("preserves the sum of ten concurrent deposits with distinct idempotency keys", async () => {
    const user = await createPlayer();
    const service = new WalletService(prisma);
    const deposits = Array.from({ length: 10 }, (_, index) => ({ amount: new Prisma.Decimal(index + 1).toFixed(4), idempotencyKey: nextKey(`concurrent-${index}`) }));
    await Promise.all(deposits.map((deposit) => service.deposit({ userId: user.id, ...deposit })));
    const expected = deposits.reduce((sum, deposit) => sum.plus(deposit.amount), new Prisma.Decimal(0));
    const wallet = await prisma.walletAccount.findUniqueOrThrow({ where: { userId: user.id } });
    expect(wallet.realBalance.equals(expected)).toBe(true);
    const { transactions, entries } = await entriesForKeys(deposits.map((deposit) => deposit.idempotencyKey));
    expect(transactions).toHaveLength(10);
    expect(entries).toHaveLength(20);
    expectBalanced(entries);
  });
});
