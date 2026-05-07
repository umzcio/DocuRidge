/**
 * Envelope-comments service. Single function shared by both the sender
 * (dashboard) and recipient (signing token) call sites — both record an
 * audit chain entry alongside the comment row so the chain captures the
 * message body and the timestamp tamper-evidently.
 */
import { prisma } from '../prisma';
import { recordEnvelopeEvent } from '../audit/envelope';

export interface AddCommentArgs {
  envelopeId: string;
  body: string;
  /** Either authorUserId (sender) or authorRecipientId (recipient) is set. */
  authorUserId?: string;
  authorRecipientId?: string;
  authorName: string;
  authorEmail?: string;
  ipAddress?: string;
  userAgent?: string;
}

export async function addComment(args: AddCommentArgs): Promise<{ id: string }> {
  const body = args.body.trim();
  if (!body) throw new Error('Comment body is required');
  if (body.length > 4000) throw new Error('Comment is too long (max 4000 chars)');
  if (!args.authorUserId && !args.authorRecipientId) {
    throw new Error('Either authorUserId or authorRecipientId is required');
  }

  const comment = await prisma.envelopeComment.create({
    data: {
      envelopeId: args.envelopeId,
      authorUserId: args.authorUserId ?? null,
      authorRecipientId: args.authorRecipientId ?? null,
      authorName: args.authorName.trim().slice(0, 120),
      body,
    },
  });
  await recordEnvelopeEvent({
    envelopeId: args.envelopeId,
    type: 'comment.added',
    actorUserId: args.authorUserId,
    actorRecipientId: args.authorRecipientId,
    actorEmail: args.authorEmail,
    actorName: args.authorName,
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
    data: { commentId: comment.id, preview: body.slice(0, 200) },
  });
  return { id: comment.id };
}
