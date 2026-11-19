ALTER TABLE "PushSubscription" ADD COLUMN "lastActiveAt" TEXT;
ALTER TABLE "PushNotificationState" ADD COLUMN "deliveryCursor" TEXT NOT NULL DEFAULT '{}';
