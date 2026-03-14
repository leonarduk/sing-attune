import { beforeEach, describe, expect, it, vi } from 'vitest';

function buildSession(selectedPart: string) {
  return {
    model: {
      title: 'Test',
      parts: ['Soprano', 'Alto'],
      notes: [],
      tempo_marks: [],
      time_signatures: [],
      total_beats: 0,
    },
    renderer: {} as never,
    cursor: {} as never,
    engine: {} as never,
    selectedPart,
  };
}

describe('score-session store', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('notifies score-loaded listeners only when session loads', async () => {
    const store = await import('./score-session');
    const onLoaded = vi.fn();
    const onPartChanged = vi.fn();

    store.onScoreLoaded(onLoaded);
    store.onPartChanged(onPartChanged);

    const session = buildSession('Soprano');
    store.setSession(session);
    store.updateSelectedPart('Alto');

    expect(onLoaded).toHaveBeenCalledTimes(1);
    expect(onLoaded).toHaveBeenCalledWith(session);

    expect(onPartChanged).toHaveBeenCalledTimes(1);
    expect(onPartChanged).toHaveBeenNthCalledWith(1, {
      ...session,
      selectedPart: 'Alto',
    });
  });

  it('does not notify part-changed listeners when selected part is unchanged', async () => {
    const store = await import('./score-session');
    const onPartChanged = vi.fn();

    store.onPartChanged(onPartChanged);

    const session = buildSession('Soprano');
    store.setSession(session);
    store.updateSelectedPart('Soprano');

    expect(onPartChanged).not.toHaveBeenCalled();
  });
});
