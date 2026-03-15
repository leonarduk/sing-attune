export type PartOption = {
  name: string;
  hiddenByDefault: boolean;
};

export type MixerGroup = 'my-part' | 'other-vocals' | 'accompaniment';

export function isAccompanimentPart(partName: string): boolean {
  const normalized = partName.toLowerCase();
  return ['piano', 'keyboard', 'pianoforte', 'accomp', 'accompaniment', 'pno', 'kbd', 'organ', 'orchestra', 'continuo']
    .some((alias) => normalized.includes(alias));
}

export function getMixerGroup(partName: string, selectedPart: string): MixerGroup {
  if (partName === selectedPart) return 'my-part';
  if (isAccompanimentPart(partName)) return 'accompaniment';
  return 'other-vocals';
}

export function getVisiblePartOptions(parts: string[], includeAccompaniment: boolean): PartOption[] {
  const options = parts.map((name) => ({ name, hiddenByDefault: isAccompanimentPart(name) }));
  if (includeAccompaniment) return options;

  const filtered = options.filter((option) => !option.hiddenByDefault);
  return filtered.length > 0 ? filtered : options;
}
