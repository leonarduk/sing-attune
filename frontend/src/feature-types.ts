/**
 * Shared Feature interface.
 *
 * Lives here — not in registry.ts — so that feature modules can import it
 * without creating a circular dependency with the registry that imports them.
 *
 * registry.ts re-exports it for consumers that only care about the registry.
 */
export interface Feature {
  /** Must match the id of the corresponding DOM slot in index.html. */
  id: string;
  mount(slot: HTMLElement): void;
  unmount?(): void;
}
