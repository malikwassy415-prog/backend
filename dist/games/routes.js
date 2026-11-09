import { Prisma } from "@prisma/client";
import jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { baccaratOutcome, blackjackOutcome, createServerSeed, hashServerSeed, playMines, plinkoOutcome, rouletteOutcome, videoPokerDeal, videoPokerOutcome } from "./engine.js";
import { WalletError, WalletService } from "../wallet.js";
const commitSchema = z.object({ client_seed: z.string().min(1).max(128).optional() }).strict();
const resolveSchema = z.object({
    round_id: z.string().uuid(), amount: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/), idempotency_key: z.string().min(1).max(128),
    bet_type: z.enum(["number", "red", "black", "dozen", "mines", "plinko", "blackjack", "player", "banker", "tie", "poker"]).optional(),
    selection: z.number().int().min(0).max(36).optional(), reveals: z.array(z.number().int().min(0).max(24)).max(22).optional(),
    risk: z.enum(["low", "medium", "high"]).optional(), holds: z.array(z.number().int().min(0).max(4)).max(5).optional(),
}).strict();
const red = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const scoped = (userId, key) => `${userId}:${key}`;
function minesMultiplier(safePicks) {
    if (safePicks <= 0)
        return new Prisma.Decimal(0);
    let odds = new Prisma.Decimal(1);
    for (let index = 0; index < safePicks; index++)
        odds = odds.mul(new Prisma.Decimal(25 - index).div(22 - index));
    return odds.mul("0.99");
}
async function authenticate(request, reply, prisma) {
    const secret = process.env.JWT_ACCESS_SECRET;
    const token = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : "";
    let claims = null;
    try {
        const value = secret && token ? jwt.verify(token, secret, { algorithms: ["HS256"] }) : null;
        if (value && typeof value !== "string")
            claims = value;
    }
    catch { /* invalid token */ }
    if (!claims?.sub || typeof claims.sub !== "string") {
        await reply.code(401).send({ error: "Unauthorized" });
        return null;
    }
    const user = await prisma.user.findUnique({ where: { id: claims.sub }, select: { id: true } });
    if (!user) {
        await reply.code(401).send({ error: "Unauthorized" });
        return null;
    }
    return user;
}
function sendError(reply, error) {
    if (error instanceof WalletError)
        return reply.code(error.statusCode).send({ error: error.message });
    if (error instanceof Error && error.message.startsWith("Mines reveals"))
        return reply.code(400).send({ error: error.message });
    throw error;
}
export async function registerGameRoutes(app, prisma) {
    const wallet = new WalletService(prisma);
    const isExcluded = async (userId) => Boolean(await prisma.selfExclusion.findFirst({ where: { userId, until: { gt: new Date() } }, select: { id: true } }));
    app.post("/games/:game/commit", async (request, reply) => {
        const user = await authenticate(request, reply, prisma);
        if (!user)
            return reply;
        if (await isExcluded(user.id))
            return reply.code(403).send({ error: "Play is disabled during your self-exclusion period" });
        const gameParam = request.params.game.replaceAll("-", "_").toUpperCase();
        if (!["ROULETTE", "MINES", "PLINKO", "BLACKJACK", "BACCARAT", "VIDEO_POKER"].includes(gameParam))
            return reply.code(404).send({ error: "Unknown game" });
        const parsed = commitSchema.safeParse(request.body ?? {});
        if (!parsed.success)
            return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
        const clientSeed = parsed.data.client_seed ?? randomBytes(16).toString("hex");
        const previous = await prisma.seedCommitment.aggregate({ where: { round: { userId: user.id } }, _max: { nonce: true } });
        const nonce = (previous._max.nonce ?? -1) + 1;
        const serverSeed = createServerSeed();
        const round = await prisma.gameRound.create({ data: { userId: user.id, game: gameParam, seedCommitment: { create: { serverSeedHash: hashServerSeed(serverSeed), serverSeed, clientSeed, nonce } } } });
        return reply.code(201).send({ round_id: round.id, server_seed_hash: hashServerSeed(serverSeed) });
    });
    app.post("/games/:game/resolve", async (request, reply) => {
        const user = await authenticate(request, reply, prisma);
        if (!user)
            return reply;
        if (await isExcluded(user.id))
            return reply.code(403).send({ error: "Play is disabled during your self-exclusion period" });
        const gameParam = request.params.game.replaceAll("-", "_").toUpperCase();
        const parsed = resolveSchema.safeParse(request.body);
        if (!parsed.success)
            return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
        const input = parsed.data;
        try {
            const round = await prisma.gameRound.findFirst({ where: { id: input.round_id, userId: user.id }, include: { seedCommitment: true } });
            if (!round)
                return reply.code(404).send({ error: "Game round not found" });
            if (round.game !== gameParam)
                return reply.code(400).send({ error: "Game does not match round" });
            if (round.status !== "ACTIVE" || !round.seedCommitment?.serverSeed)
                return reply.code(409).send({ error: "Round already resolved" });
            const commitment = round.seedCommitment;
            const serverSeed = commitment.serverSeed;
            const betType = input.bet_type ?? (round.game === "MINES" ? "mines" : "number");
            const validSelection = round.game === "ROULETTE"
                ? ["number", "red", "black", "dozen"].includes(betType) && (betType !== "number" || input.selection !== undefined) && (betType !== "dozen" || Boolean(input.selection && input.selection <= 3))
                : round.game === "MINES" ? betType === "mines"
                    : round.game === "PLINKO" ? betType === "plinko" && Boolean(input.risk)
                        : round.game === "BLACKJACK" ? betType === "blackjack"
                            : round.game === "BACCARAT" ? ["player", "banker", "tie"].includes(betType)
                                : round.game === "VIDEO_POKER" ? betType === "poker" && input.holds !== undefined && new Set(input.holds).size === input.holds.length
                                    : false;
            if (!validSelection)
                return reply.code(400).send({ error: "Invalid bet selection for this game" });
            const keyBase = `game:${round.id}`;
            await wallet.bet({ userId: user.id, amount: input.amount, idempotencyKey: scoped(user.id, `${keyBase}:bet`), roundId: round.id });
            let result;
            let multiplier = new Prisma.Decimal(0);
            if (round.game === "ROULETTE") {
                const number = rouletteOutcome(serverSeed, commitment.clientSeed, commitment.nonce);
                const won = betType === "number" ? number === input.selection : betType === "red" ? red.has(number) : betType === "black" ? number !== 0 && !red.has(number) : betType === "dozen" ? number > 0 && Math.ceil(number / 12) === input.selection : false;
                multiplier = won ? new Prisma.Decimal(betType === "number" ? 36 : betType === "dozen" ? 3 : 2) : new Prisma.Decimal(0);
                result = { number, bet_type: betType, selection: input.selection ?? null, won };
            }
            else if (round.game === "MINES") {
                const game = playMines(serverSeed, commitment.clientSeed, commitment.nonce, input.reveals ?? []);
                const safePicks = game.reveals.filter((item) => !item.mine).length;
                if (!game.reveals.some((item) => item.mine))
                    multiplier = minesMultiplier(safePicks);
                result = { ...game, multiplier: multiplier.toFixed(4), won: multiplier.greaterThan(0) };
            }
            else if (round.game === "PLINKO") {
                const game = plinkoOutcome(serverSeed, commitment.clientSeed, commitment.nonce, input.risk);
                multiplier = new Prisma.Decimal(game.multiplier);
                result = game;
            }
            else if (round.game === "BLACKJACK") {
                const game = blackjackOutcome(serverSeed, commitment.clientSeed, commitment.nonce);
                multiplier = new Prisma.Decimal(game.multiplier);
                result = game;
            }
            else if (round.game === "BACCARAT") {
                const game = baccaratOutcome(serverSeed, commitment.clientSeed, commitment.nonce);
                const won = game.winner === betType;
                multiplier = won ? new Prisma.Decimal(game.multiplier) : new Prisma.Decimal(0);
                result = { ...game, bet_type: betType, won, multiplier: multiplier.toFixed(4) };
            }
            else {
                const game = videoPokerOutcome(serverSeed, commitment.clientSeed, commitment.nonce, input.holds);
                multiplier = new Prisma.Decimal(game.multiplier);
                result = game;
            }
            const payout = new Prisma.Decimal(input.amount).mul(multiplier).toDecimalPlaces(4, Prisma.Decimal.ROUND_DOWN);
            await wallet.win({ userId: user.id, amount: payout.toFixed(4), idempotencyKey: scoped(user.id, `${keyBase}:win`), roundId: round.id });
            const verification = { server_seed: serverSeed, server_seed_hash: commitment.serverSeedHash, client_seed: commitment.clientSeed, nonce: commitment.nonce };
            const state = { result, bet_type: betType, amount: input.amount, payout: payout.toFixed(4), idempotency_key: input.idempotency_key, verification };
            await prisma.gameRound.update({ where: { id: round.id }, data: { status: "COMPLETED", state } });
            return { result, verification };
        }
        catch (error) {
            return sendError(reply, error);
        }
    });
    app.post("/games/video-poker/deal", async (request, reply) => {
        const user = await authenticate(request, reply, prisma);
        if (!user)
            return reply;
        if (await isExcluded(user.id))
            return reply.code(403).send({ error: "Play is disabled during your self-exclusion period" });
        const parsed = z.object({ round_id: z.string().uuid() }).strict().safeParse(request.body);
        if (!parsed.success)
            return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
        const round = await prisma.gameRound.findFirst({ where: { id: parsed.data.round_id, userId: user.id }, include: { seedCommitment: true } });
        if (!round || round.game !== "VIDEO_POKER" || round.status !== "ACTIVE" || !round.seedCommitment?.serverSeed)
            return reply.code(404).send({ error: "Active video poker round not found" });
        return { cards: videoPokerDeal(round.seedCommitment.serverSeed, round.seedCommitment.clientSeed, round.seedCommitment.nonce), server_seed_hash: round.seedCommitment.serverSeedHash };
    });
    app.post("/games/mines/reveal", async (request, reply) => {
        const user = await authenticate(request, reply, prisma);
        if (!user)
            return reply;
        if (await isExcluded(user.id))
            return reply.code(403).send({ error: "Play is disabled during your self-exclusion period" });
        const parsed = z.object({ round_id: z.string().uuid(), cell: z.number().int().min(0).max(24), amount: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/), idempotency_key: z.string().min(1).max(128) }).strict().safeParse(request.body);
        if (!parsed.success)
            return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
        const input = parsed.data;
        try {
            const round = await prisma.gameRound.findFirst({ where: { id: input.round_id, userId: user.id }, include: { seedCommitment: true } });
            if (!round)
                return reply.code(404).send({ error: "Game round not found" });
            if (round.game !== "MINES")
                return reply.code(400).send({ error: "Round is not Mines" });
            if (round.status !== "ACTIVE" || !round.seedCommitment?.serverSeed)
                return reply.code(409).send({ error: "Round already resolved" });
            const state = round.state;
            const session = state.mines;
            if (session && (session.amount !== input.amount || session.idempotency_key !== input.idempotency_key))
                return reply.code(409).send({ error: "Bet amount and idempotency key cannot change during a round" });
            const prior = session?.reveals ?? [];
            if (prior.includes(input.cell))
                return reply.code(400).send({ error: "Cell already revealed" });
            const commitment = round.seedCommitment;
            const serverSeed = commitment.serverSeed;
            await wallet.bet({ userId: user.id, amount: input.amount, idempotencyKey: scoped(user.id, `game:${round.id}:bet`), roundId: round.id });
            const reveals = [...prior, input.cell];
            const game = playMines(serverSeed, commitment.clientSeed, commitment.nonce, reveals);
            const last = game.reveals.at(-1);
            const safePicks = game.reveals.filter((item) => !item.mine).length;
            const multiplier = last.mine ? new Prisma.Decimal(0) : minesMultiplier(safePicks);
            if (last.mine) {
                await wallet.win({ userId: user.id, amount: "0.0000", idempotencyKey: scoped(user.id, `game:${round.id}:win`), roundId: round.id });
                const verification = { server_seed: serverSeed, server_seed_hash: commitment.serverSeedHash, client_seed: commitment.clientSeed, nonce: commitment.nonce };
                const result = { ...game, multiplier: "0.0000", won: false };
                const finalState = { result, amount: input.amount, idempotency_key: input.idempotency_key, verification };
                await prisma.gameRound.update({ where: { id: round.id }, data: { status: "COMPLETED", state: finalState } });
                return { result, verification, completed: true };
            }
            const nextState = { ...state, mines: { amount: input.amount, idempotency_key: input.idempotency_key, reveals } };
            await prisma.gameRound.update({ where: { id: round.id }, data: { state: nextState } });
            return { result: { cell: input.cell, mine: false, safe_picks: safePicks, multiplier: multiplier.toFixed(4) }, completed: false };
        }
        catch (error) {
            return sendError(reply, error);
        }
    });
    app.post("/games/mines/cashout", async (request, reply) => {
        const user = await authenticate(request, reply, prisma);
        if (!user)
            return reply;
        const parsed = z.object({ round_id: z.string().uuid(), idempotency_key: z.string().min(1).max(128) }).strict().safeParse(request.body);
        if (!parsed.success)
            return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
        try {
            const round = await prisma.gameRound.findFirst({ where: { id: parsed.data.round_id, userId: user.id }, include: { seedCommitment: true } });
            if (!round)
                return reply.code(404).send({ error: "Game round not found" });
            if (round.game !== "MINES")
                return reply.code(400).send({ error: "Round is not Mines" });
            if (round.status !== "ACTIVE" || !round.seedCommitment?.serverSeed)
                return reply.code(409).send({ error: "Round already resolved" });
            const state = round.state;
            const session = state.mines;
            if (!session || session.reveals.length === 0)
                return reply.code(400).send({ error: "Reveal at least one safe cell before cashing out" });
            const commitment = round.seedCommitment;
            const serverSeed = commitment.serverSeed;
            const game = playMines(serverSeed, commitment.clientSeed, commitment.nonce, session.reveals);
            const multiplier = minesMultiplier(game.reveals.length);
            const payout = new Prisma.Decimal(session.amount).mul(multiplier).toDecimalPlaces(4, Prisma.Decimal.ROUND_DOWN);
            await wallet.win({ userId: user.id, amount: payout.toFixed(4), idempotencyKey: scoped(user.id, `game:${round.id}:win`), roundId: round.id });
            const verification = { server_seed: serverSeed, server_seed_hash: commitment.serverSeedHash, client_seed: commitment.clientSeed, nonce: commitment.nonce };
            const result = { ...game, multiplier: multiplier.toFixed(4), payout: payout.toFixed(4), won: true };
            const finalState = { result, amount: session.amount, idempotency_key: session.idempotency_key, verification };
            await prisma.gameRound.update({ where: { id: round.id }, data: { status: "COMPLETED", state: finalState } });
            return { result, verification, completed: true };
        }
        catch (error) {
            return sendError(reply, error);
        }
    });
    app.get("/games/verify/:round_id", async (request, reply) => {
        const id = request.params.round_id;
        if (!z.string().uuid().safeParse(id).success)
            return reply.code(400).send({ error: "Invalid round id" });
        const round = await prisma.gameRound.findUnique({ where: { id }, include: { seedCommitment: true } });
        if (!round || round.status !== "COMPLETED" || !round.seedCommitment?.serverSeed)
            return reply.code(404).send({ error: "Completed round not found" });
        const { serverSeed, serverSeedHash, clientSeed, nonce } = round.seedCommitment;
        return { result: round.state.result, verification: { server_seed: serverSeed, server_seed_hash: serverSeedHash, client_seed: clientSeed, nonce } };
    });
}
