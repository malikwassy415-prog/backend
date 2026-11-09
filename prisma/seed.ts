import { PrismaClient, UserRole } from "@prisma/client";

const prisma = new PrismaClient();
const demoUsers = [
  { email: "player1@example.test", role: UserRole.PLAYER, bonus: "100.0000" },
  { email: "player2@example.test", role: UserRole.PLAYER, bonus: "250.0000" },
  { email: "admin@example.test", role: UserRole.ADMIN, bonus: "0.0000" },
] as const;

async function main() {
  for (const demo of demoUsers) {
    const user = await prisma.user.upsert({
      where: { email: demo.email },
      update: { role: demo.role },
      create: { email: demo.email, role: demo.role, passwordHash: "DEMO_ONLY_PASSWORD_HASH_NOT_FOR_AUTH" },
    });
    await prisma.walletAccount.upsert({
      where: { userId: user.id },
      update: { realBalance: "0.0000", bonusBalance: demo.bonus },
      create: { userId: user.id, realBalance: "0.0000", bonusBalance: demo.bonus, currency: "EUR" },
    });
  }
  const [users, wallets] = await Promise.all([prisma.user.count(), prisma.walletAccount.count()]);
  console.log(`Seed complete: ${users} users, ${wallets} wallet accounts`);
}

main().finally(() => prisma.$disconnect());
