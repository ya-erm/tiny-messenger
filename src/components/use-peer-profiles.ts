"use client";

import { useEffect, useState } from "react";
import { cachedPeerProfile, cachePeerProfile } from "@/lib/client-storage";
import type { ChannelId } from "@/lib/client-transport";
import type { PublicContact, PublicMessage, PublicUser } from "@/lib/types";

const REFRESH_INTERVAL = 60_000;
type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

// An incoming conversation need not be a saved contact. Fetch its public
// profile separately without changing the address book or message history.
export function usePeerProfiles(userId: string, channel: ChannelId, online: boolean,
  contacts: PublicContact[], messages: PublicMessage[], request: Request) {
  const saved = new Set(contacts.map(contact => contact.userId));
  const ids = [...new Set(messages.map(message => message.fromUserId === userId ? message.toUserId : message.fromUserId))]
    .filter(id => id !== userId && !saved.has(id)).sort().join(",");
  const key = `${userId}:${channel}:${ids}`;
  const [profiles, setProfiles] = useState<{ key: string; users: Map<string, PublicUser> }>({ key: "", users: new Map() });

  useEffect(() => {
    let disposed = false, running = false;
    const users = new Map<string, PublicUser>(), attempted = new Map<string, number>();
    const publish = () => { if (!disposed) setProfiles({ key, users: new Map(users) }); };
    const peerIds = ids ? ids.split(",") : [];
    const load = Promise.all(peerIds.map(async id => {
      const cached = await cachedPeerProfile(userId, channel, id).catch(() => undefined);
      if (cached) { users.set(id, cached.user); attempted.set(id, cached.checkedAt); }
    })).then(publish);

    const refresh = async () => {
      if (!online || running || document.visibilityState !== "visible") return;
      running = true;
      try {
        await load;
        for (const id of peerIds) {
          if (disposed) break;
          const now = Date.now();
          if (now - (attempted.get(id) || 0) < REFRESH_INTERVAL) continue;
          attempted.set(id, now);
          try {
            const data = await request<{ users: PublicUser[] }>(`/api/users?query=${encodeURIComponent(id)}`);
            if (disposed) break;
            const user = data.users.find(user => user.id === id);
            if (!user) continue;
            users.set(id, user);
            publish();
            await cachePeerProfile(userId, channel, user, now).catch(() => {});
          } catch { /* Keep the cached profile when a channel is unavailable. */ }
        }
      } finally { running = false; }
    };
    if (userId) void refresh();
    const interval = online ? window.setInterval(() => { void refresh(); }, REFRESH_INTERVAL) : undefined;
    const visible = () => { void refresh(); };
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [userId, channel, online, ids, key, request]);

  return profiles.key === key ? profiles.users : new Map<string, PublicUser>();
}
