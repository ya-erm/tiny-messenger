CREATE TABLE "PushNotificationState" (
  "userId" TEXT NOT NULL PRIMARY KEY,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "dueAt" TEXT,
  "firstPendingAt" TEXT,
  "alertAfter" TEXT,
  "hasNotification" BOOLEAN NOT NULL DEFAULT false,
  "leaseUntil" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "PushNotificationState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PushNotificationState_dueAt_idx" ON "PushNotificationState"("dueAt");
-- Existing subscriptions may still have notifications from the old worker.
INSERT INTO "PushNotificationState" ("userId", "hasNotification")
SELECT DISTINCT "userId", true FROM "PushSubscription";
