CREATE TABLE "TasksAccountLink" ("tasksUserId" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "linkId" TEXT NOT NULL, FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE);
CREATE UNIQUE INDEX "TasksAccountLink_userId_key" ON "TasksAccountLink"("userId");
CREATE UNIQUE INDEX "TasksAccountLink_linkId_key" ON "TasksAccountLink"("linkId");
CREATE TABLE "TasksConsumedProof" ("nonce" TEXT NOT NULL PRIMARY KEY, "expiresAt" INTEGER NOT NULL);
