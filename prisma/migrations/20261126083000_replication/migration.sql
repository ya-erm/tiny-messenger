CREATE TABLE "ReplicationState" (
  "key" TEXT NOT NULL PRIMARY KEY,
  "body" TEXT NOT NULL
);
ALTER TABLE "Message" ADD COLUMN "receiptStatus" TEXT;
