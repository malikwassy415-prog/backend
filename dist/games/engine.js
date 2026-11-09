import { createHash, createHmac, randomBytes } from "node:crypto";
export const createServerSeed = () => randomBytes(32).toString("hex");
export const hashServerSeed = (serverSeed) => createHash("sha256").update(serverSeed).digest("hex");
export const hmacDigest = (serverSeed, clientSeed, nonce, block = 0) => createHmac("sha256", serverSeed).update(`${clientSeed}:${nonce}${block === 0 ? "" : `:${block}`}`).digest();
export function floatsFromDigest(digest) {
    const values = [];
    for (let offset = 0; offset + 4 <= digest.length; offset += 4)
        values.push(digest.readUInt32BE(offset) / 0x1_0000_0000);
    return values;
}
/** First block follows the published protocol exactly. Counter blocks extend the stream for Mines. */
export class FairStream {
    serverSeed;
    clientSeed;
    nonce;
    block = 0;
    values = [];
    cursor = 0;
    constructor(serverSeed, clientSeed, nonce) {
        this.serverSeed = serverSeed;
        this.clientSeed = clientSeed;
        this.nonce = nonce;
    }
    next() {
        if (this.cursor >= this.values.length) {
            this.values = floatsFromDigest(hmacDigest(this.serverSeed, this.clientSeed, this.nonce, this.block++));
            this.cursor = 0;
        }
        return this.values[this.cursor++];
    }
    consumed() { return (this.block - 1) * 8 + this.cursor; }
}
export function rouletteOutcome(serverSeed, clientSeed, nonce) {
    return Math.floor(new FairStream(serverSeed, clientSeed, nonce).next() * 37);
}
const SUITS = ["♠", "♥", "♦", "♣"];
function shuffledDeck(stream) {
    const deck = SUITS.flatMap(suit => Array.from({ length: 13 }, (_, index) => ({ rank: index + 1, suit })));
    for (let index = deck.length - 1; index > 0; index--) {
        const swap = Math.floor(stream.next() * (index + 1));
        [deck[index], deck[swap]] = [deck[swap], deck[index]];
    }
    return deck;
}
const cardValue = (rank) => rank === 1 ? 11 : Math.min(rank, 10);
function blackjackTotal(cards) {
    let total = cards.reduce((sum, card) => sum + cardValue(card.rank), 0);
    let aces = cards.filter(card => card.rank === 1).length;
    while (total > 21 && aces > 0) {
        total -= 10;
        aces--;
    }
    return total;
}
export function blackjackOutcome(serverSeed, clientSeed, nonce) {
    const deck = shuffledDeck(new FairStream(serverSeed, clientSeed, nonce));
    const player = [deck.pop(), deck.pop()];
    const dealer = [deck.pop(), deck.pop()];
    const playerNatural = blackjackTotal(player) === 21;
    const dealerNatural = blackjackTotal(dealer) === 21;
    while (blackjackTotal(dealer) < 17)
        dealer.push(deck.pop());
    const playerTotal = blackjackTotal(player);
    const dealerTotal = blackjackTotal(dealer);
    const multiplier = playerNatural && !dealerNatural ? "2.5000" : playerNatural && dealerNatural || playerTotal === dealerTotal ? "1.0000" : playerTotal > dealerTotal ? "2.0000" : "0.0000";
    return { player, dealer, player_total: playerTotal, dealer_total: dealerTotal, player_natural: playerNatural, dealer_natural: dealerNatural, outcome: multiplier === "0.0000" ? "LOSS" : multiplier === "1.0000" ? "PUSH" : "WIN", multiplier };
}
const BACCARAT_VALUE = (rank) => rank <= 9 ? rank : 0;
function baccaratScore(cards) { return cards.reduce((total, card) => total + BACCARAT_VALUE(card.rank), 0) % 10; }
export function baccaratOutcome(serverSeed, clientSeed, nonce) {
    const deck = shuffledDeck(new FairStream(serverSeed, clientSeed, nonce));
    const player = [deck.pop(), deck.pop()];
    const banker = [deck.pop(), deck.pop()];
    let playerScore = baccaratScore(player);
    let bankerScore = baccaratScore(banker);
    if (playerScore < 8 && bankerScore < 8) {
        let playerThird;
        if (playerScore <= 5) {
            playerThird = deck.pop();
            player.push(playerThird);
            playerScore = baccaratScore(player);
        }
        const bankerDraws = playerThird
            ? bankerScore <= 2 || bankerScore === 3 && BACCARAT_VALUE(playerThird.rank) !== 8 || bankerScore === 4 && BACCARAT_VALUE(playerThird.rank) >= 2 && BACCARAT_VALUE(playerThird.rank) <= 7 || bankerScore === 5 && BACCARAT_VALUE(playerThird.rank) >= 4 && BACCARAT_VALUE(playerThird.rank) <= 7 || bankerScore === 6 && BACCARAT_VALUE(playerThird.rank) >= 6 && BACCARAT_VALUE(playerThird.rank) <= 7
            : bankerScore <= 5;
        if (bankerDraws) {
            banker.push(deck.pop());
            bankerScore = baccaratScore(banker);
        }
    }
    const winner = playerScore === bankerScore ? "tie" : playerScore > bankerScore ? "player" : "banker";
    return { player, banker, player_score: playerScore, banker_score: bankerScore, winner, multiplier: winner === "tie" ? "8.0000" : winner === "banker" ? "1.9500" : "2.0000" };
}
const PLINKO_PAYOUTS = {
    low: ["6.6000", "3.3000", "1.6500", "1.1500", "1.0000", "0.9000", "0.8000", "0.9000", "1.0000", "1.1500", "1.6500", "3.3000", "6.6000"],
    medium: ["12.0000", "5.0000", "2.5000", "1.4000", "1.1000", "0.8000", "0.4000", "0.8000", "1.1000", "1.4000", "2.5000", "5.0000", "12.0000"],
    high: ["40.0000", "10.0000", "4.0000", "2.0000", "1.0000", "0.3000", "0.2000", "0.3000", "1.0000", "2.0000", "4.0000", "10.0000", "40.0000"],
};
export function plinkoOutcome(serverSeed, clientSeed, nonce, risk) {
    const stream = new FairStream(serverSeed, clientSeed, nonce);
    const path = Array.from({ length: 12 }, () => stream.next() >= 0.5 ? "R" : "L");
    const bin = path.filter(step => step === "R").length;
    const multiplier = PLINKO_PAYOUTS[risk][bin];
    return { path, bin, risk, multiplier, won: Number(multiplier) >= 1 };
}
export function videoPokerDeal(serverSeed, clientSeed, nonce) {
    const deck = shuffledDeck(new FairStream(serverSeed, clientSeed, nonce));
    return deck.slice(0, 5);
}
const payoutForPoker = (hand) => {
    const counts = new Map();
    for (const card of hand)
        counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
    const groups = [...counts.values()].sort((a, b) => b - a);
    const ranks = hand.map(card => card.rank).sort((a, b) => a - b);
    const flush = hand.every(card => card.suit === hand[0].suit);
    const straight = ranks.every((rank, index) => index === 0 || rank === ranks[index - 1] + 1) || ranks.join(",") === "1,10,11,12,13";
    if (flush && straight && ranks.includes(1) && ranks.includes(13))
        return { hand: "ROYAL_FLUSH", multiplier: "250.0000" };
    if (flush && straight)
        return { hand: "STRAIGHT_FLUSH", multiplier: "50.0000" };
    if (groups[0] === 4)
        return { hand: "FOUR_OF_A_KIND", multiplier: "25.0000" };
    if (groups[0] === 3 && groups[1] === 2)
        return { hand: "FULL_HOUSE", multiplier: "9.0000" };
    if (flush)
        return { hand: "FLUSH", multiplier: "6.0000" };
    if (straight)
        return { hand: "STRAIGHT", multiplier: "4.0000" };
    if (groups[0] === 3)
        return { hand: "THREE_OF_A_KIND", multiplier: "3.0000" };
    if (groups[0] === 2 && groups[1] === 2)
        return { hand: "TWO_PAIR", multiplier: "2.0000" };
    const jacksOrBetter = [...counts].some(([rank, count]) => count === 2 && rank >= 11);
    return jacksOrBetter ? { hand: "JACKS_OR_BETTER", multiplier: "1.0000" } : { hand: "NO_WIN", multiplier: "0.0000" };
};
export function videoPokerOutcome(serverSeed, clientSeed, nonce, holds) {
    const deck = shuffledDeck(new FairStream(serverSeed, clientSeed, nonce));
    const initial = deck.slice(0, 5);
    const held = new Set(holds);
    let next = 5;
    const cards = initial.map((card, index) => held.has(index) ? card : deck[next++]);
    const payout = payoutForPoker(cards);
    return { initial, holds: [...held].sort(), cards, hand: payout.hand, multiplier: payout.multiplier, won: payout.multiplier !== "0.0000" };
}
export function playMines(serverSeed, clientSeed, nonce, reveals) {
    const stream = new FairStream(serverSeed, clientSeed, nonce);
    const available = Array.from({ length: 25 }, (_, index) => index);
    const mines = Array.from({ length: 3 }, () => available.splice(Math.floor(stream.next() * available.length), 1)[0]);
    const revealed = [];
    const seen = new Set();
    for (const cell of reveals) {
        if (!Number.isInteger(cell) || cell < 0 || cell > 24 || seen.has(cell))
            throw new Error("Mines reveals must be unique cells from 0 to 24");
        seen.add(cell);
        const draw = stream.next();
        revealed.push({ cell, draw, mine: mines.includes(cell) });
        if (mines.includes(cell))
            break;
    }
    return { mine_positions: mines, reveals: revealed, consumed_floats: stream.consumed(), cleared: revealed.length === reveals.length && !revealed.some((r) => r.mine) };
}
