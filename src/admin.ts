import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { PrismaClient } from "@prisma/client";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { z } from "zod";
import { WalletError, WalletService } from "./wallet.js";

async function adminUser(request: FastifyRequest, reply: FastifyReply, prisma: PrismaClient) {
  const secret = process.env.JWT_ACCESS_SECRET;
  const token = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : "";
  let payload: JwtPayload | null = null;
  try { const value = secret && token ? jwt.verify(token, secret, { algorithms: ["HS256"] }) : null; if (value && typeof value !== "string") payload = value; } catch { /* invalid token */ }
  if (!payload?.sub || typeof payload.sub !== "string") { await reply.code(401).send({ error: "Unauthorized" }); return null; }
  const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { id: true, role: true } });
  if (!user) { await reply.code(401).send({ error: "Unauthorized" }); return null; }
  if (user.role !== "ADMIN") { await reply.code(403).send({ error: "Forbidden" }); return null; }
  return user;
}

export async function registerAdminRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const wallet = new WalletService(prisma);
  app.get("/admin/users", async (request, reply) => {
    const admin = await adminUser(request, reply, prisma); if (!admin) return reply;
    const query = z.string().max(254).safeParse((request.query as { q?: string }).q ?? "");
    if (!query.success) return reply.code(400).send({ error: "Invalid query" });
    return prisma.user.findMany({ where: query.data ? { email: { contains: query.data, mode: "insensitive" } } : {}, select: { id: true, email: true, role: true, kycStatus: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 50 });
  });
  app.get("/admin/kyc", async (request, reply) => {
    const admin = await adminUser(request, reply, prisma); if (!admin) return reply;
    return prisma.kycProfile.findMany({ where: { status: "PENDING" }, include: { user: { select: { id: true, email: true } } }, orderBy: { id: "asc" }, take: 100 });
  });
  app.get("/admin/withdrawals", async (request, reply) => {
    const admin = await adminUser(request, reply, prisma); if (!admin) return reply;
    return prisma.withdrawalRequest.findMany({ where: { status: "PENDING" }, include: { user: { select: { email: true } } }, orderBy: { createdAt: "asc" }, take: 100 });
  });
  app.get("/admin/audit-logs", async (request, reply) => {
    const admin = await adminUser(request, reply, prisma); if (!admin) return reply;
    return prisma.auditLog.findMany({ include: { actor: { select: { email: true } } }, orderBy: { createdAt: "desc" }, take: 100 });
  });
  app.post("/admin/withdrawals/:id/reject", async (request, reply) => {
    const admin = await adminUser(request, reply, prisma); if (!admin) return reply;
    const id = (request.params as { id: string }).id;
    if (!z.string().uuid().safeParse(id).success) return reply.code(400).send({ error: "Invalid withdrawal id" });
    const body = z.object({ idempotency_key: z.string().min(1).max(128) }).strict().safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid request", details: body.error.flatten() });
    try { return await wallet.rejectWithdrawal({ withdrawalId: id, adminUserId: admin.id, idempotencyKey: `admin:${admin.id}:${body.data.idempotency_key}` }); }
    catch (error) { if (error instanceof WalletError) return reply.code(error.statusCode).send({ error: error.message }); throw error; }
  });
}
