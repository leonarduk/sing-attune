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

  it('supports unsubscribing score-loaded and score-cleared listeners', async () => {
    const store = await import('./score-session');
    const onLoaded = vi.fn();
    const onCleared = vi.fn();

    const unsubscribeLoaded = store.onScoreLoaded(onLoaded);
    const unsubscribeCleared = store.onScoreCleared(onCleared);

    store.setSession(buildSession('Soprano'));
    expect(onLoaded).toHaveBeenCalledTimes(1);

    unsubscribeLoaded();
    unsubscribeCleared();

    store.setSession(buildSession('Alto'));
    store.clearSession();

    expect(onLoaded).toHaveBeenCalledTimes(1);
    expect(onCleared).toHaveBeenCalledTimes(0);
  });

  it('deduplicates and unsubscribes score session callbacks', async () => {
    const store = await import('./score-session');
    const onLoaded = vi.fn();
    const onCleared = vi.fn();

    const unsubscribeLoadedA = store.onScoreLoaded(onLoaded);
    const unsubscribeLoadedB = store.onScoreLoaded(onLoaded);
    const unsubscribeClearedA = store.onScoreCleared(onCleared);
    const unsubscribeClearedB = store.onScoreCleared(onCleared);

    const session = buildSession('Soprano');
    store.setSession(session);
    store.clearSession();

    expect(onLoaded).toHaveBeenCalledTimes(2); // two registrations, each fires once
    expect(onCleared).toHaveBeenCalledTimes(2);

    unsubscribeLoadedA();
    unsubscribeLoadedB();
    unsubscribeClearedA();
    unsubscribeClearedB();

    store.setSession(session);
    store.clearSession();

    expect(onLoaded).toHaveBeenCalledTimes(2); // no further calls after unsubscribe
    expect(onCleared).toHaveBeenCalledTimes(2);
  });

  it('fires score-loaded callback immediately when subscribing with an active session', async () => {
    const store = await import('./score-session');
    const existing = buildSession('Soprano');
    store.setSession(existing);

    const onLoaded = vi.fn();
    const unsubscribe = store.onScoreLoaded(onLoaded);

    expect(onLoaded).toHaveBeenCalledTimes(1);
    expect(onLoaded).toHaveBeenCalledWith(existing);

    unsubscribe();
  });

});
