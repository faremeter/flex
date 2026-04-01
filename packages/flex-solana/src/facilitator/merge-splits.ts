type Split = { recipient: string; bps: number };

export function mergeSplits(splits: Split[]): Split[] {
  const merged = new Map<string, number>();
  for (const s of splits) {
    merged.set(s.recipient, (merged.get(s.recipient) ?? 0) + s.bps);
  }
  return [...merged.entries()].map(([recipient, bps]) => ({ recipient, bps }));
}
