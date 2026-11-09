ALTER TABLE "wallet_accounts"
  ALTER COLUMN "user_id" DROP NOT NULL,
  ADD COLUMN "system_key" TEXT;

CREATE UNIQUE INDEX "wallet_accounts_system_key_key" ON "wallet_accounts"("system_key");

ALTER TABLE "transactions" ADD COLUMN "response" JSONB;

ALTER TABLE "payment_intents" ADD COLUMN "idempotency_key" TEXT;
UPDATE "payment_intents" SET "idempotency_key" = 'legacy:' || "id"::text WHERE "idempotency_key" IS NULL;
ALTER TABLE "payment_intents" ALTER COLUMN "idempotency_key" SET NOT NULL;
CREATE UNIQUE INDEX "payment_intents_idempotency_key_key" ON "payment_intents"("idempotency_key");

ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_amount_positive" CHECK ("amount" > 0);
