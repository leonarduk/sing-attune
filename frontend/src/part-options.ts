export type PartOption = {
  name: string;
  hiddenByDefault: boolean;
};

export function isAccompanimentPart(partName: string): boolean {
  const normalized = partName.toLowerCase();
  return ['piano', 'keyboard', 'accompaniment', 'accomp', 'pno', 'kbd']
    .some((alias) => normalized.includes(alias));
}

export function getVisiblePartOptions(parts: string[], includeAccompaniment: boolean): PartOption[] {
  const options = parts.map((name) => ({ name, hiddenByDefault: isAccompanimentPart(name) }));
  if (includeAccompaniment) return options;

  const filtered = options.filter((option) => !option.hiddenByDefault);
  return filtered.length > 0 ? filtered : options;
}
