import { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";

const MoneyInput = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/);
const IdempotencyKey = z.string().min(1).max(128);

export class WalletError extends Error {
  constructor(public readonly statusCode: number, message: string) { super(message); this.name = "WalletError"; }
}
class VersionConflict extends Error {}
type Tx = Prisma.TransactionClient;
type TransferEntry = { accountId: string; direction: "DEBIT" | "CREDIT"; amount: Prisma.Decimal; currency: string };
type WalletResponse = Record<string, unknown>;

export class WalletService {
  private static readonly accountQueues = new Map<string, Promise<void>>();
  constructor(private readonly prisma: PrismaClient) {}

  async deposit(input: { userId: string; amount: string; idempotencyKey: string }): Promise<WalletResponse> {
    const amount = this.validate(input.amount, input.idempotencyKey);
    return this.runIdempotent(input.idempotencyKey, async (tx) => {
      const wallet = await this.userWallet(tx, input.userId);
      const house = await this.systemWallet(tx, "HOUSE");
      const transaction = await tx.transaction.create({ data: { type: "DEPOSIT", idempotencyKey: input.idempotencyKey, status: "PENDING" } });
      const entries = this.transfer(house.id, wallet.id, amount, wallet.currency);
      await this.applyEntries(tx, entries);
      const updated = await tx.walletAccount.findUniqueOrThrow({ where: { id: wallet.id } });
      const response = { transactionId: transaction.id, balance: updated.realBalance.toFixed(4), currency: updated.currency };
      await tx.transaction.update({ where: { id: transaction.id }, data: { status: "COMPLETED", response } });
      await tx.ledgerEntry.createMany({ data: entries.map((entry) => ({ ...entry, transactionId: transaction.id })) });
      return response;
    }, input.userId);
  }

  async withdraw(input: { userId: string; amount: string; idempotencyKey: string }): Promise<WalletResponse> {
    const amount = this.validate(input.amount, input.idempotencyKey);
    return this.runIdempotent(input.idempotencyKey, async (tx) => {
      const wallet = await this.userWallet(tx, input.userId);
      const house = await this.systemWallet(tx, "HOUSE");
      const pending = await this.systemWallet(tx, "PENDING_WITHDRAWALS");
      const transaction = await tx.transaction.create({ data: { type: "WITHDRAWAL", idempotencyKey: input.idempotencyKey, status: "PENDING" } });
      // The request records a balanced pending obligation between system accounts; player funds remain untouched.
      const entries = this.transfer(house.id, pending.id, amount, wallet.currency);
      await this.applyEntries(tx, entries);
      await tx.ledgerEntry.createMany({ data: entries.map((entry) => ({ ...entry, transactionId: transaction.id })) });
      const request = await tx.withdrawalRequest.create({ data: { userId: input.userId, amount, status: "PENDING" } });
      const response = { withdrawalId: request.id, transactionId: transaction.id, status: "PENDING", amount: amount.toFixed(4), balance: wallet.realBalance.toFixed(4), currency: wallet.currency };
      await tx.transaction.update({ where: { id: transaction.id }, data: { response } });
      return response;
    }, input.userId);
  }

  async bet(input: { userId: string; amount: string; idempotencyKey: string; roundId?: string }): Promise<WalletResponse> {
    const amount = this.validate(input.amount, input.idempotencyKey);
    return this.runIdempotent(input.idempotencyKey, async (tx) => {
      const wallet = await this.userWallet(tx, input.userId);
      const house = await this.systemWallet(tx, "HOUSE");
      const transaction = await tx.transaction.create({ data: { type: "BET", idempotencyKey: input.idempotencyKey, status: "PENDING" } });
      const entries = this.transfer(wallet.id, house.id, amount, wallet.currency);
      await this.applyEntries(tx, entries);
      await tx.ledgerEntry.createMany({ data: entries.map((entry) => ({ ...entry, transactionId: transaction.id })) });
      if (input.roundId) await tx.bet.create({ data: { roundId: input.roundId, amount, status: "PLACED" } });
      const updated = await tx.walletAccount.findUniqueOrThrow({ where: { id: wallet.id } });
      const response = { transactionId: transaction.id, balance: updated.realBalance.toFixed(4), currency: updated.currency };
      await tx.transaction.update({ where: { id: transaction.id }, data: { status: "COMPLETED", response } });
      return response;
    }, input.userId);
  }

  async win(input: { userId: string; amount: string; idempotencyKey: string; roundId?: string }): Promise<WalletResponse> {
    const amount = this.validate(input.amount, input.idempotencyKey, true);
    if (amount.isZero()) {
      return this.withAccountLock(input.userId, async () => {
        const wallet = await this.prisma.walletAccount.findUnique({ where: { userId: input.userId } });
        if (!wallet) throw new WalletError(404, "Wallet account not found");
        return { transactionId: null, balance: wallet.realBalance.toFixed(4), currency: wallet.currency, payout: "0.0000" };
      });
    }
    return this.runIdempotent(input.idempotencyKey, async (tx) => {
      const wallet = await this.userWallet(tx, input.userId);
      const house = await this.systemWallet(tx, "HOUSE");
      const transaction = await tx.transaction.create({ data: { type: "WIN", idempotencyKey: input.idempotencyKey, status: "PENDING" } });
      const entries = this.transfer(house.id, wallet.id, amount, wallet.currency);
      await this.applyEntries(tx, entries);
      await tx.ledgerEntry.createMany({ data: entries.map((entry) => ({ ...entry, transactionId: transaction.id })) });
      if (input.roundId) await tx.bet.updateMany({ where: { roundId: input.roundId }, data: { status: "WON" } });
      const updated = await tx.walletAccount.findUniqueOrThrow({ where: { id: wallet.id } });
      const response = { transactionId: transaction.id, balance: updated.realBalance.toFixed(4), currency: updated.currency };
      await tx.transaction.update({ where: { id: transaction.id }, data: { status: "COMPLETED", response } });
      return response;
    }, input.userId);
  }

  async approveWithdrawal(input: { withdrawalId: string; adminUserId: string; idempotencyKey: string }): Promise<WalletResponse> {
    IdempotencyKey.parse(input.idempotencyKey);
    const pendingRequest = await this.prisma.withdrawalRequest.findUnique({ where: { id: input.withdrawalId }, select: { userId: true } });
    if (!pendingRequest) throw new WalletError(404, "Withdrawal request not found");
    return this.runIdempotent(input.idempotencyKey, async (tx) => {
      const request = await tx.withdrawalRequest.findUnique({ where: { id: input.withdrawalId } });
      if (!request) throw new WalletError(404, "Withdrawal request not found");
      if (request.status !== "PENDING") return { withdrawalId: request.id, status: request.status, amount: request.amount.toFixed(4) };
      const wallet = await this.userWallet(tx, request.userId);
      const house = await this.systemWallet(tx, "HOUSE");
      const transaction = await tx.transaction.create({ data: { type: "WITHDRAWAL", idempotencyKey: input.idempotencyKey, status: "PENDING" } });
      const entries = this.transfer(wallet.id, house.id, request.amount, wallet.currency);
      await this.applyEntries(tx, entries);
      await tx.ledgerEntry.createMany({ data: entries.map((entry) => ({ ...entry, transactionId: transaction.id })) });
      await tx.withdrawalRequest.update({ where: { id: request.id }, data: { status: "APPROVED", reviewedBy: input.adminUserId } });
      const updated = await tx.walletAccount.findUniqueOrThrow({ where: { id: wallet.id } });
      const response = { withdrawalId: request.id, transactionId: transaction.id, status: "APPROVED", amount: request.amount.toFixed(4), balance: updated.realBalance.toFixed(4), currency: wallet.currency };
      await tx.transaction.update({ where: { id: transaction.id }, data: { status: "COMPLETED", response } });
      await tx.auditLog.create({ data: {
        actorId: input.adminUserId,
        action: "withdrawal.approved",
        targetType: "withdrawal_request",
        targetId: request.id,
        before: { status: request.status, balance: wallet.realBalance.toFixed(4) },
        after: { status: "APPROVED", balance: updated.realBalance.toFixed(4) },
      } });
      return response;
    }, pendingRequest.userId);
  }

  async rejectWithdrawal(input: { withdrawalId: string; adminUserId: string; idempotencyKey: string }): Promise<WalletResponse> {
    IdempotencyKey.parse(input.idempotencyKey);
    const pendingRequest = await this.prisma.withdrawalRequest.findUnique({ where: { id: input.withdrawalId }, select: { userId: true } });
    if (!pendingRequest) throw new WalletError(404, "Withdrawal request not found");
    return this.runIdempotent(input.idempotencyKey, async (tx) => {
      const request = await tx.withdrawalRequest.findUnique({ where: { id: input.withdrawalId } });
      if (!request) throw new WalletError(404, "Withdrawal request not found");
      if (request.status !== "PENDING") return { withdrawalId: request.id, status: request.status, amount: request.amount.toFixed(4) };
      const wallet = await this.userWallet(tx, request.userId);
      const house = await this.systemWallet(tx, "HOUSE");
      const pending = await this.systemWallet(tx, "PENDING_WITHDRAWALS");
      const transaction = await tx.transaction.create({ data: { type: "WITHDRAWAL", idempotencyKey: input.idempotencyKey, status: "PENDING" } });
      const entries = this.transfer(pending.id, house.id, request.amount, wallet.currency);
      await this.applyEntries(tx, entries);
      await tx.ledgerEntry.createMany({ data: entries.map((entry) => ({ ...entry, transactionId: transaction.id })) });
      await tx.withdrawalRequest.update({ where: { id: request.id }, data: { status: "REJECTED", reviewedBy: input.adminUserId } });
      const response = { withdrawalId: request.id, transactionId: transaction.id, status: "REJECTED", amount: request.amount.toFixed(4), balance: wallet.realBalance.toFixed(4), currency: wallet.currency };
      await tx.transaction.update({ where: { id: transaction.id }, data: { status: "COMPLETED", response } });
      await tx.auditLog.create({ data: { actorId: input.adminUserId, action: "withdrawal.rejected", targetType: "withdrawal_request", targetId: request.id, before: { status: request.status }, after: { status: "REJECTED" } } });
      return response;
    }, pendingRequest.userId);
  }

  async getTransactionResponse(idempotencyKey: string): Promise<WalletResponse | null> {
    const transaction = await this.prisma.transaction.findUnique({ where: { idempotencyKey }, select: { response: true } });
    return (transaction?.response as WalletResponse | null) ?? null;
  }

  private validate(amount: string, key: string, allowZero = false): Prisma.Decimal {
    IdempotencyKey.parse(key);
    const parsed = new Prisma.Decimal(MoneyInput.parse(amount));
    if (!allowZero && !parsed.greaterThan(0)) throw new Error("Amount must be greater than zero");
    return parsed;
  }

  private transfer(debitAccountId: string, creditAccountId: string, amount: Prisma.Decimal, currency: string): TransferEntry[] {
    return [
      { accountId: debitAccountId, direction: "DEBIT", amount, currency },
      { accountId: creditAccountId, direction: "CREDIT", amount, currency },
    ];
  }

  private async userWallet(tx: Tx, userId: string) {
    const wallet = await tx.walletAccount.findUnique({ where: { userId } });
    if (!wallet) throw new WalletError(404, "Wallet account not found");
    return wallet;
  }

  private async systemWallet(tx: Tx, key: string) {
    return tx.walletAccount.upsert({ where: { systemKey: key }, update: {}, create: { systemKey: key, currency: "EUR" } });
  }

  private async applyEntries(tx: Tx, entries: TransferEntry[]) {
    const deltas = new Map<string, Prisma.Decimal>();
    for (const entry of entries) {
      const signed = entry.direction === "CREDIT" ? entry.amount : entry.amount.negated();
      deltas.set(entry.accountId, (deltas.get(entry.accountId) ?? new Prisma.Decimal(0)).plus(signed));
    }
    for (const accountId of [...deltas.keys()].sort()) {
      const rows = await tx.$queryRaw<Array<{ version: number; real_balance: Prisma.Decimal; bonus_balance: Prisma.Decimal; system_key: string | null }>>`
        SELECT "version", "real_balance", "bonus_balance", "system_key"
        FROM "wallet_accounts" WHERE "id" = ${accountId}::uuid FOR UPDATE
      `;
      const row = rows[0];
      if (!row) throw new WalletError(404, "Ledger account not found");
      const nextBalance = new Prisma.Decimal(row.real_balance).plus(deltas.get(accountId)!);
      if (!row.system_key && nextBalance.lessThan(0)) throw new WalletError(409, "Insufficient real balance");
      const result = await tx.walletAccount.updateMany({
        where: { id: accountId, version: row.version },
        data: { realBalance: nextBalance, version: { increment: 1 } },
      });
      if (result.count !== 1) throw new VersionConflict("Wallet version changed during mutation");
    }
  }

  private async withAccountLock<T>(accountKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = WalletService.accountQueues.get(accountKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    WalletService.accountQueues.set(accountKey, tail);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (WalletService.accountQueues.get(accountKey) === tail) WalletService.accountQueues.delete(accountKey);
    }
  }

  private async runIdempotent(key: string, operation: (tx: Tx) => Promise<WalletResponse>, accountLockKey?: string): Promise<WalletResponse> {
    if (accountLockKey) return this.withAccountLock(accountLockKey, () => this.runIdempotent(key, operation));
    const existing = await this.getTransactionResponse(key);
    if (existing) return existing;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const prior = await tx.transaction.findUnique({ where: { idempotencyKey: key }, select: { response: true } });
          if (prior?.response) return prior.response as WalletResponse;
          return operation(tx);
        }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 30_000, timeout: 30_000 });
      } catch (error) {
        if (error instanceof VersionConflict && attempt === 0) continue;
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          const winner = await this.getTransactionResponse(key);
          if (winner) return winner;
        }
        if (error instanceof VersionConflict) throw new WalletError(409, "Wallet changed; retry the request");
        throw error;
      }
    }
    throw new WalletError(409, "Wallet changed; retry the request");
  }
}
