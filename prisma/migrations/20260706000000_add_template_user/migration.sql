-- AlterTable: add optional userId to ExportTemplate (null = global/admin template)
ALTER TABLE "ExportTemplate" ADD COLUMN "userId" TEXT;

-- AddForeignKey
ALTER TABLE "ExportTemplate" ADD CONSTRAINT "ExportTemplate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
