CREATE TABLE "MutationOperation" (
    "seq" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "operationId" TEXT NOT NULL,
    "protocolVersion" INTEGER NOT NULL,
    "actorId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "occurredAt" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "receivedAt" TEXT NOT NULL
);
CREATE UNIQUE INDEX "MutationOperation_operationId_key" ON "MutationOperation"("operationId");
CREATE INDEX "MutationOperation_actorId_seq_idx" ON "MutationOperation"("actorId", "seq");
CREATE INDEX "MutationOperation_entityId_idx" ON "MutationOperation"("entityId");
