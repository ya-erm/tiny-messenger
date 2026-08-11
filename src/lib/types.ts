export type MessageKind = "text" | "choice";
export type MessageStatus = "sent" | "delivered" | "read" | "answered";

export interface UserRecord {
  id: string;
  name: string;
  avatarUrl?: string;
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

export interface MessageRecord {
  id: string;
  fromUserId: string;
  toUserId: string;
  senderName: string;
  text: string;
  kind: MessageKind;
  options?: ChoiceOption[];
  sentAt: string;
  deliveredAt?: string;
  readAt?: string;
  answer?: {
    id: string;
    label: string;
    answeredAt: string;
  };
}

export interface StoreData {
  version: 1;
  users: UserRecord[];
  contacts: ContactRecord[];
  messages: MessageRecord[];
}

export interface PublicUser {
  id: string;
  name: string;
  avatarUrl?: string;
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
