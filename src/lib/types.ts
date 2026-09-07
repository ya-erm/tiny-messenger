export type MessageKind = "text" | "choice";
export type MessageStatus = "sent" | "delivered" | "read" | "answered";

export interface UserRecord {
  id: string;
  name: string;
  nickname?: string;
  avatarUrl?: string;
  avatarBackground?: string;
  tokenHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContactRecord {
  ownerId: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChoiceOption {
  id: string;
  label: string;
}

// "Deleted for me" marks live in their own table and are applied as a query
// filter, so a record the caller can see never carries them.
export interface MessageRecord {
  id: string;
  fromUserId: string;
  toUserId: string;
  senderName: string;
  text: string;
  kind: MessageKind;
  options?: ChoiceOption[];
  sentAt: string;
  editedAt?: string;
  answer?: {
    id: string;
    label: string;
    answeredAt: string;
  };
}

export interface GroupRecord {
  id: string;
  name: string;
  avatarUrl?: string;
  avatarBackground?: string;
  ownerId: string;
  // In join order; the same order as `members`.
  memberIds: string[];
  members: UserRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface GroupMessageRecord {
  id: string;
  groupId: string;
  fromUserId: string;
  senderName: string;
  text: string;
  sentAt: string;
  editedAt?: string;
}

// Delivery and read marks are watermarks per (reader, chat) rather than fields on
// every message: a message counts as delivered/read by `userId` when its sentAt is
// at or before the cursor. `chatId` is the peer's user ID for a 1:1 conversation
// and the group ID for a group, so one record shape serves both.
export interface ReadStateRecord {
  userId: string;
  chatId: string;
  lastDeliveredAt?: string;
  lastReadAt?: string;
}

export interface PushSubscriptionRecord {
  userId: string;
  endpoint: string;
  expirationTime?: number;
  keys: {
    p256dh: string;
    auth: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface PublicUser {
  id: string;
  name: string;
  nickname?: string;
  avatarUrl?: string;
  avatarBackground?: string;
  createdAt: string;
}

export interface PublicContact {
  userId: string;
  user: PublicUser;
  createdAt: string;
  updatedAt: string;
}

export interface PublicMessage extends MessageRecord {
  status: MessageStatus;
}

export interface PublicGroup {
  id: string;
  name: string;
  avatarUrl?: string;
  avatarBackground?: string;
  ownerId: string;
  members: PublicUser[];
  createdAt: string;
  updatedAt: string;
}

export interface PublicGroupMessage extends GroupMessageRecord {
  status: MessageStatus;
}
