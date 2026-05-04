CREATE TABLE "SiteFinancials" (
    "id"        TEXT         NOT NULL,
    "siteId"    TEXT         NOT NULL,
    "params"    JSONB        NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SiteFinancials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SiteFinancials_siteId_key" ON "SiteFinancials"("siteId");

ALTER TABLE "SiteFinancials"
    ADD CONSTRAINT "SiteFinancials_siteId_fkey"
    FOREIGN KEY ("siteId")
    REFERENCES "Site"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;
