import "server-only";

import webpush from "web-push";
import { read, write } from "@/lib/db";
import { toPushSubscriptionRecord } from "@/lib/store";

export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
  kind?: "message" | "voice_invite" | "message_summary";
  userId?: string;
  revision?: number;
  unreadCount?: number;
  silent?: boolean;
  sessionId?: string;
  fromUserId?: string;
}

let configuredFor = "";

export function pushConfiguration() {
  const publicKey = process.env.WEB_PUSH_VAPID_PUBLIC_KEY?.trim() || "";
  const privateKey = process.env.WEB_PUSH_VAPID_PRIVATE_KEY?.trim() || "";
  const subject = process.env.WEB_PUSH_VAPID_SUBJECT?.trim() || "mailto:admin@example.com";
  return {
    configured: Boolean(publicKey && privateKey),
    publicKey,
    privateKey,
    subject,
  };
}

function configureWebPush() {
  const configuration = pushConfiguration();
  if (!configuration.configured) return false;

  const fingerprint = `${configuration.subject}:${configuration.publicKey}:${configuration.privateKey}`;
  if (configuredFor !== fingerprint) {
    webpush.setVapidDetails(
      configuration.subject,
      configuration.publicKey,
      configuration.privateKey,
    );
    configuredFor = fingerprint;
  }
  return true;
}

export async function sendPushToUser(userId: string, payload: PushPayload, options: { topic?: string } = {}) {
  if (!configureWebPush()) return { sent: 0, failed: 0 };

  const rows = await read((db) => db.pushSubscription.findMany({ where: { userId } }));
  const subscriptions = rows.map(toPushSubscriptionRecord);
  if (!subscriptions.length) return { sent: 0, failed: 0 };
  let sent = 0;
  let failed = 0;

  const expiredEndpoints: string[] = [];
  await Promise.allSettled(subscriptions.map(async (subscription) => {
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          expirationTime: subscription.expirationTime ?? null,
          keys: subscription.keys,
        },
        JSON.stringify(payload),
        { TTL: 60 * 60, urgency: payload.silent ? "normal" : "high", timeout: 5000, ...(options.topic ? { topic: options.topic } : {}) },
      );
      sent++;
    } catch (error) {
      const statusCode = typeof error === "object" && error && "statusCode" in error
        ? Number(error.statusCode)
        : 0;
      if (statusCode === 404 || statusCode === 410) {
        expiredEndpoints.push(subscription.endpoint);
        return;
      }
      failed++;
      console.error(JSON.stringify({ event: "web-push", status: statusCode || "unavailable" }));
    }
  }));

  if (expiredEndpoints.length) {
    await write((tx) => tx.pushSubscription.deleteMany({ where: { userId, endpoint: { in: expiredEndpoints } } }));
  }
  return { sent, failed };
}
