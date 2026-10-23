export async function createAndSendEnvelopeAction(_previous: unknown, formData: FormData) {
  const file = formData.get('document') as File;
  Object.assign(window, {
    __submittedPdf: Array.from(new Uint8Array(await file.arrayBuffer())),
    __submittedFields: JSON.parse(String(formData.get('fields'))),
    __submittedDocuments: JSON.parse(String(formData.get('documents'))),
  });
  return { ok: true };
}
