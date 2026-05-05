-- AddForeignKey
ALTER TABLE "sealed_document" ADD CONSTRAINT "sealed_document_documentFileId_fkey" FOREIGN KEY ("documentFileId") REFERENCES "document_file"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
