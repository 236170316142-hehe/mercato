-- CreateTable
CREATE TABLE "KeepaCodeLookup" (
    "code" TEXT NOT NULL,
    "domain" INTEGER NOT NULL,
    "asins" TEXT[],
    "source" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KeepaCodeLookup_pkey" PRIMARY KEY ("code","domain")
);

-- CreateTable
CREATE TABLE "KeepaProductCache" (
    "asin" TEXT NOT NULL,
    "domain" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "priceAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KeepaProductCache_pkey" PRIMARY KEY ("asin","domain")
);

-- CreateIndex
CREATE INDEX "KeepaCodeLookup_fetchedAt_idx" ON "KeepaCodeLookup"("fetchedAt");

-- CreateIndex
CREATE INDEX "KeepaProductCache_fetchedAt_idx" ON "KeepaProductCache"("fetchedAt");

-- CreateIndex
CREATE INDEX "Product_upc_idx" ON "Product"("upc");

-- CreateIndex
CREATE INDEX "Product_asin_idx" ON "Product"("asin");
