-- CreateTable
CREATE TABLE "BlogSource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "feedUrl" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'RSS',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastCheckedAt" DATETIME,
    "lastSeenExternalId" TEXT,
    "lastSeenPublishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Article" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "rawSummary" TEXT,
    "rawContent" TEXT,
    "publishedAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Article_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "BlogSource" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LinkedInPost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "articleId" TEXT NOT NULL,
    "contentDraft" TEXT NOT NULL,
    "contentFinal" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'AUTO',
    "linkedInPostUrn" TEXT,
    "linkedInPostUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LinkedInPost_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CriteriaConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL DEFAULT 'default',
    "includeKeywords" TEXT NOT NULL,
    "excludeKeywords" TEXT NOT NULL,
    "targetAudienceDescription" TEXT NOT NULL,
    "defaultHashtags" TEXT NOT NULL,
    "maxPostsPerDay" INTEGER NOT NULL DEFAULT 3,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "LinkedInToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "memberUrn" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "scopes" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "message" TEXT NOT NULL,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "BlogSource_active_idx" ON "BlogSource"("active");

-- CreateIndex
CREATE INDEX "Article_status_idx" ON "Article"("status");

-- CreateIndex
CREATE INDEX "Article_publishedAt_idx" ON "Article"("publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Article_sourceId_externalId_key" ON "Article"("sourceId", "externalId");

-- CreateIndex
CREATE INDEX "LinkedInPost_status_idx" ON "LinkedInPost"("status");

-- CreateIndex
CREATE INDEX "LinkedInPost_createdAt_idx" ON "LinkedInPost"("createdAt");

-- CreateIndex
CREATE INDEX "CriteriaConfig_active_idx" ON "CriteriaConfig"("active");

-- CreateIndex
CREATE UNIQUE INDEX "LinkedInToken_memberUrn_key" ON "LinkedInToken"("memberUrn");

-- CreateIndex
CREATE INDEX "ActivityLog_type_idx" ON "ActivityLog"("type");

-- CreateIndex
CREATE INDEX "ActivityLog_createdAt_idx" ON "ActivityLog"("createdAt");
