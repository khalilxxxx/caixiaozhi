import type {
  ExpenseField,
  ExpenseItem,
  SubmissionDefaultSource,
  SubmissionDraft,
} from './submission-model';

export function setManualExpenseField(
  item: ExpenseItem,
  field: ExpenseField,
  value: string,
): ExpenseItem {
  if (field !== 'currency' && field !== 'rental')
    return { ...item, [field]: value };
  return {
    ...item,
    [field]: value,
    manualFields: [...new Set([...(item.manualFields ?? []), field])],
  };
}

export interface ActiveSubmissionDefault extends SubmissionDefaultSource {
  path: string;
}

// Only the server assigns provenance. Hide it immediately when the user edits
// a value locally, before the server has reconciled the next workspace patch.
export function activeSubmissionDefaults(
  draft: SubmissionDraft,
): ActiveSubmissionDefault[] {
  return Object.entries(draft.autoFill?.fields ?? {}).flatMap(
    ([path, entry]) => {
      if (!entry || !entry.value || draft.autoFill?.suppressed?.includes(path))
        return [];
      const [group, id, field] = path.split('.');
      let value: unknown;
      let label = entry.label;
      if ((group === 'legs' || group === 'expenses') && id && field) {
        const items = draft[group];
        const index = items.findIndex((item) => item.id === id);
        const item = items[index];
        if (!item) return [];
        value = (item as unknown as Record<string, unknown>)[field];
        label = `${group === 'legs' ? `第${index + 1}段` : `第${index + 1}笔费用`}${label}`;
      } else if (!id) {
        value = (draft as unknown as Record<string, unknown>)[path];
      }
      return value === entry.value ? [{ ...entry, label, path }] : [];
    },
  );
}
