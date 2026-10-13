CREATE TABLE "MessageReaction" (
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    PRIMARY KEY ("messageId", "userId"),
    CONSTRAINT "MessageReaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MessageReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "GroupMessageReaction" (
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    PRIMARY KEY ("messageId", "userId"),
    CONSTRAINT "GroupMessageReaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "GroupMessage" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GroupMessageReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
