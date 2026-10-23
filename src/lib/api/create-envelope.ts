import { z } from 'zod';

/**
 * POST /api/v1/envelopes body validation + template role mapping.
 * Kept separate from the route handler so the validation matrix is unit-testable.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const RecipientSchema = z.object({
  name: z.string().trim().min(1, 'Recipient name is required.').max(120, 'Recipient name is too long.'),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(320, 'Recipient email is too long.')
    .refine((v) => EMAIL_RE.test(v), 'Enter a valid recipient email.'),
  /**
   * Optional template-role label (free text, matched case-insensitively against
   * the template's role labels). Omit to map recipients to roles in order.
   */
  role: z.string().trim().min(1, 'Role cannot be empty.').max(120, 'Role is too long.').optional(),
});

export const CreateEnvelopeBodySchema = z.object({
  templateId: z.string().min(1, 'templateId is required.'),
  title: z.string().trim().min(1, 'Title cannot be empty.').max(200, 'Title is too long.').optional(),
  recipients: z
    .array(RecipientSchema)
    .min(1, 'At least one recipient is required.')
    .max(25, 'At most 25 recipients are allowed.'),
});

export type CreateEnvelopeBody = z.infer<typeof CreateEnvelopeBodySchema>;

export interface TemplateRoleSource {
  id: string;
  name: string;
  roleLabel: string | null;
}

export class ApiValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiValidationError';
  }
}

/**
 * Map the API's ordered recipient list onto a template's roles. When an API
 * recipient carries an explicit `role`, it is matched to the template role
 * with that label (case-insensitive); otherwise the next unmatched template
 * role in signing order is used. Count must match exactly — silently dropping
 * or inventing roles would change who a contract is routed to.
 */
export function buildRoleMappings(
  templateRoles: TemplateRoleSource[],
  apiRecipients: CreateEnvelopeBody['recipients'],
): Record<string, { name: string; email: string }> {
  if (apiRecipients.length !== templateRoles.length) {
    throw new ApiValidationError(
      `Recipient count (${apiRecipients.length}) does not match the template's roles (${templateRoles.length}).`,
    );
  }

  const unmatched = new Set(templateRoles.map((r) => r.id));
  const mappings: Record<string, { name: string; email: string }> = {};

  for (const api of apiRecipients) {
    let tplId: string | undefined;
    if (api.role) {
      const wanted = api.role.toLowerCase();
      tplId = templateRoles.find(
        (r) =>
          unmatched.has(r.id) &&
          ((r.roleLabel ?? '').trim().toLowerCase() === wanted || r.name.trim().toLowerCase() === wanted),
      )?.id;
      if (!tplId) {
        throw new ApiValidationError(`Template has no role named "${api.role}".`);
      }
    } else {
      tplId = templateRoles.find((r) => unmatched.has(r.id))?.id;
    }
    if (!tplId) throw new ApiValidationError('Could not map recipients to template roles.');
    unmatched.delete(tplId);
    mappings[tplId] = { name: api.name.trim(), email: api.email.toLowerCase().trim() };
  }

  return mappings;
}
