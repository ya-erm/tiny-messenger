ALTER TABLE "Message" ADD COLUMN "clientRequestId" TEXT;
ALTER TABLE "Message" ADD COLUMN "requestHash" TEXT;
ALTER TABLE "GroupMessage" ADD COLUMN "clientRequestId" TEXT;
ALTER TABLE "GroupMessage" ADD COLUMN "requestHash" TEXT;
CREATE UNIQUE INDEX "Message_fromUserId_clientRequestId_key" ON "Message"("fromUserId", "clientRequestId");
CREATE UNIQUE INDEX "GroupMessage_fromUserId_clientRequestId_key" ON "GroupMessage"("fromUserId", "clientRequestId");

CREATE TABLE "Attachment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "uploaderId" TEXT NOT NULL,
  "clientRequestId" TEXT NOT NULL,
  "chatKind" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "stagingKey" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL,
  "originalName" TEXT NOT NULL,
  "contentType" TEXT NOT NULL,
  "requestedSize" BIGINT NOT NULL,
  "confirmedSize" BIGINT,
  "reservedBytes" BIGINT NOT NULL,
  "etag" TEXT,
  "sourceEtag" TEXT,
  "status" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "expiresAt" TEXT NOT NULL,
  "abandonAt" TEXT NOT NULL,
  "leaseUntil" TEXT,
  "leaseToken" TEXT,
  "stagingDeletedAt" TEXT,
  "deleteAfter" TEXT,
  "messageId" TEXT,
  "groupMessageId" TEXT,
  CONSTRAINT "Attachment_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Attachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "Attachment_groupMessageId_fkey" FOREIGN KEY ("groupMessageId") REFERENCES "GroupMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CHECK ("requestedSize" >= 0 AND "reservedBytes" >= 0),
  CHECK ("messageId" IS NULL OR "groupMessageId" IS NULL)
);
CREATE UNIQUE INDEX "Attachment_stagingKey_key" ON "Attachment"("stagingKey");
CREATE UNIQUE INDEX "Attachment_objectKey_key" ON "Attachment"("objectKey");
CREATE UNIQUE INDEX "Attachment_uploaderId_clientRequestId_key" ON "Attachment"("uploaderId", "clientRequestId");
CREATE INDEX "Attachment_uploaderId_status_idx" ON "Attachment"("uploaderId", "status");
CREATE INDEX "Attachment_status_expiresAt_idx" ON "Attachment"("status", "expiresAt");
CREATE INDEX "Attachment_status_abandonAt_idx" ON "Attachment"("status", "abandonAt");
CREATE INDEX "Attachment_deleteAfter_idx" ON "Attachment"("deleteAfter");
