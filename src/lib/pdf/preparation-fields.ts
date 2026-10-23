type Dependency = { condition?: { whenFieldId: string } };
type Field = Dependency & { id: string; dataLabel?: string; formula?: string };

/** Deletion must not leave a dangling formula or a hidden routing dependency. */
export function assertSafePageDeletion(before: Field[], after: Field[], recipients: Dependency[]): void {
  const kept = new Set(after.map(f => f.id));
  const removed = before.filter(f => !kept.has(f.id));
  const removedIds = new Set(removed.map(f => f.id));
  const removedTokens = new Set(removed.flatMap(f => [f.id, ...(f.dataLabel?.trim() ? [f.dataLabel.trim()] : [])]));
  if (after.some(f => (f.condition && removedIds.has(f.condition.whenFieldId)) ||
      [...(f.formula ?? '').matchAll(/\{([^}]+)\}/g)].some(match => removedTokens.has(match[1]!.trim()))) ||
      recipients.some(r => r.condition && removedIds.has(r.condition.whenFieldId))) {
    throw new Error('A field on a deleted page is used by a formula or condition. Update those dependencies before deleting this page.');
  }
}

/** Formula persistence resolves labels by last match, so additions must be unique. */
export function uniqueFieldLabels<T extends { label: string }>(suggestions: T[], fields: { dataLabel?: string }[]): T[] {
  const used = new Set(fields.map(f => f.dataLabel?.trim()).filter(Boolean));
  return suggestions.map(s => {
    const base = s.label.trim() || 'Field';
    let label = base.slice(0, 120); let suffix = 2;
    while (used.has(label)) {
      const ending = ` (${suffix++})`;
      label = base.slice(0, 120 - ending.length) + ending;
    }
    used.add(label);
    return { ...s, label };
  });
}
