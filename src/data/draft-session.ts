import type { Runtime as HouseRuntime } from './house';

export type DraftParts = Parameters<HouseRuntime['roomDraft']['write']>[3];
export type RoomDraft = NonNullable<Awaited<ReturnType<HouseRuntime['roomDraft']['read']>>>;
export type DraftPatch = DraftParts | ((current: RoomDraft | null) => DraftParts);
export function mergeDraftParts(current: DraftParts, patch: DraftParts): DraftParts {
  return {
    ...current, ...patch,
    ...(current.fields || patch.fields ? { fields: { ...current.fields, ...patch.fields } } : {}),
    ...(current.sections || patch.sections ? { sections: { ...current.sections, ...patch.sections } } : {}),
  };
}
/** Durable Room-local edits. Master1420: later local input wins a stale overlap;
 * retain disjoint parts and first bases; only explicit Save queues a change. */
export class DraftSession {
  private draft: RoomDraft | null = null;
  private readonly opened: Promise<RoomDraft | null>;
  private tail: Promise<unknown>;
  private epoch = 0;
  private listeners = new Set<(draft: RoomDraft | null) => void>();
  readonly runtime: HouseRuntime;
  readonly room: string;
  readonly path: string;
  constructor(runtime: HouseRuntime, room: string, path: string) {
    this.runtime = runtime; this.room = room; this.path = path;
    const epoch = this.epoch;
    this.opened = runtime.roomDraft.read(room, path).then(draft => {
      if (this.epoch === epoch) this.accept(draft);
      return this.draft;
    });
    this.tail = this.opened;
  }
  async read() { await this.opened; await this.tail; return this.draft; }
  current() { return this.draft; }
  /** Feed this from the Runtime's live room-drafts observation, including null
   * when that draft is saved/discarded. Never infer author or device identity. */
  accept(draft: RoomDraft | null) {
    if (draft && (draft.room !== this.room || draft.path !== this.path)) throw new Error('Draft scope does not match this editor.');
    this.epoch++;
    this.draft = draft;
    this.listeners.forEach(listener => listener(draft));
  }
  subscribe(listener: (draft: RoomDraft | null) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.catch(() => undefined).then(work);
    this.tail = result;
    return result;
  }
  stage(input: DraftPatch): Promise<RoomDraft | null> {
    return this.serialize(async () => {
      await this.opened;
      let known = this.draft;
      for (;;) {
        const patch = typeof input === 'function' ? input(known) : input;
        const parts = mergeDraftParts(known?.parts ?? {}, patch);
        const epoch = this.epoch;
        const result = await this.runtime.roomDraft.write(this.room, this.path, known?.revision ?? null, parts);
        if (result.outcome === 'written') {
          // A newer observation may arrive while the local bridge answer is in
          // flight. Do not redraw that newer shared draft with an older reply.
          if (this.epoch === epoch) this.accept(result.roomDraft);
          else this.accept(await this.runtime.roomDraft.read(this.room, this.path));
          return this.draft;
        }
        // The Runtime owns revision comparison. Re-read, preserve its current
        // parts, and reapply this editor's latest queued input as instructed.
        known = await this.runtime.roomDraft.read(this.room, this.path);
        this.draft = known;
      }
    });
  }
  flush() { return this.tail; }
  commit(): Promise<string | null> {
    return this.serialize(async () => {
      await this.opened;
      const draft = this.draft;
      if (!draft) return null;
      const result = await this.runtime.save(this.room, [{ path: this.path, revision: draft.revision }]);
      if (result.outcome !== 'saved') throw new Error(`House did not queue this draft: ${result.rule}. The draft is preserved.`);
      // Save clears the named revision only. Retain later typing from a tab.
      this.accept(await this.runtime.roomDraft.read(this.room, this.path));
      return result.identifier;
    });
  }
}
