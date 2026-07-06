-- Add raw file bytes storage to ExportTemplate so exports can use the original file as base
ALTER TABLE "ExportTemplate" ADD COLUMN "fileData" BYTEA;
