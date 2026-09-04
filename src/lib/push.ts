import "server-only";

import webpush from "web-push";
import { readStore, updateStore } from "@/lib/store";

export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
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

export async function sendPushToUser(userId: string, payload: PushPayload) {
  if (!configureWebPush()) return;

  const store = await readStore();
  const subscriptions = store.pushSubscriptions.filter((item) => item.userId === userId);
  if (!subscriptions.length) return;

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
        { TTL: 60 * 60, urgency: "high", timeout: 5000 },
      );
    } catch (error) {
      const statusCode = typeof error === "object" && error && "statusCode" in error
        ? Number(error.statusCode)
        : 0;
      if (statusCode === 404 || statusCode === 410) {
        expiredEndpoints.push(subscription.endpoint);
        return;
      }
      console.error("Failed to send web push notification", error);
    }
  }));

  if (expiredEndpoints.length) {
    const expired = new Set(expiredEndpoints);
    await updateStore((currentStore) => {
      currentStore.pushSubscriptions = currentStore.pushSubscriptions.filter(
        (subscription) => !expired.has(subscription.endpoint),
      );
    });
  }
}
