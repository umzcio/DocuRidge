/**
 * JSON serializers for the REST API v1 envelope resources.
 *
 * Stable camelCase field names, ISO-8601 dates (null when unset), recipients
 * summarized to identity/routing/status. The input shapes are structural
 * (plain interfaces) rather than Prisma validator types so the serializers
 * stay unit-testable without a database.
 */

export interface RecipientSource {
  id: string;
  name: string;
  email: string;
  recipientRole: string;
  roleLabel: string | null;
  signingOrder: number;
  readStatus: string;
  signingStatus: string;
  sentAt: Date | null;
  signedAt: Date | null;
  declinedAt: Date | null;
}

export interface EnvelopeSummarySource {
  id: string;
  title: string;
  status: string;
  routingMode: string;
  createdById: string;
  templateOriginId: string | null;
  message: string | null;
  createdAt: Date;
  updatedAt: Date;
  sentAt: Date | null;
  completedAt: Date | null;
  expiresAt: Date | null;
  recipients: RecipientSource[];
}

export interface DocumentSource {
  id: string;
  title: string;
  order: number;
  pageCount: number;
  documentFile: {
    id: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    canonicalSha256: string | null;
  };
}

export interface ApiRecipientJson {
  id: string;
  name: string;
  email: string;
  role: string;
  roleLabel: string | null;
  signingOrder: number;
  readStatus: string;
  signingStatus: string;
  sentAt: string | null;
  signedAt: string | null;
  declinedAt: string | null;
}

export interface ApiEnvelopeSummaryJson {
  id: string;
  title: string;
  status: string;
  routingMode: string;
  createdById: string;
  templateOriginId: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  completedAt: string | null;
  expiresAt: string | null;
  recipients: ApiRecipientJson[];
}

export interface ApiDocumentJson {
  id: string;
  title: string;
  order: number;
  pageCount: number;
  documentFileId: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  /** The canonical copy signers see; null until one has been made. */
  canonicalSha256: string | null;
}

export interface ApiEnvelopeDetailJson extends ApiEnvelopeSummaryJson {
  message: string | null;
  documents: ApiDocumentJson[];
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

export function serializeRecipient(r: RecipientSource): ApiRecipientJson {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.recipientRole,
    roleLabel: r.roleLabel,
    signingOrder: r.signingOrder,
    readStatus: r.readStatus,
    signingStatus: r.signingStatus,
    sentAt: iso(r.sentAt),
    signedAt: iso(r.signedAt),
    declinedAt: iso(r.declinedAt),
  };
}

export function serializeEnvelopeSummary(env: EnvelopeSummarySource): ApiEnvelopeSummaryJson {
  return {
    id: env.id,
    title: env.title,
    status: env.status,
    routingMode: env.routingMode,
    createdById: env.createdById,
    templateOriginId: env.templateOriginId,
    createdAt: env.createdAt.toISOString(),
    updatedAt: env.updatedAt.toISOString(),
    sentAt: iso(env.sentAt),
    completedAt: iso(env.completedAt),
    expiresAt: iso(env.expiresAt),
    recipients: env.recipients.map(serializeRecipient),
  };
}

export function serializeDocument(doc: DocumentSource): ApiDocumentJson {
  return {
    id: doc.id,
    title: doc.title,
    order: doc.order,
    pageCount: doc.pageCount,
    documentFileId: doc.documentFile.id,
    mimeType: doc.documentFile.mimeType,
    sizeBytes: doc.documentFile.sizeBytes,
    sha256: doc.documentFile.sha256,
    canonicalSha256: doc.documentFile.canonicalSha256,
  };
}

export function serializeEnvelopeDetail(
  env: EnvelopeSummarySource & { items: DocumentSource[] },
): ApiEnvelopeDetailJson {
  return {
    ...serializeEnvelopeSummary(env),
    message: env.message,
    documents: env.items.map(serializeDocument),
  };
}
