import { DraftSession, type RoomDraft } from "./draft-session";
import { MAX_FILE_BYTES, uploadAttachment } from "./assets";
import { houseBridge as getHouseBridge } from "@agentshouse/app-bridge";
import {
  chatSchema,
  attachmentSchema,
  messageSchema,
  callSchema,
  callPartSchema,
  type Store,
  type Snapshot,
  type Message,
  type Chat,
  type CallPart,
  type Author,
  type ComposerDraft,
} from "./model";
export type Runtime = Awaited<ReturnType<typeof getHouseBridge>["runtime"]>;
type Document = {
  room: string;
  path: string;
  type?: string;
  fields?: Readonly<Record<string, unknown>>;
  change?: {
    author?: { kind: string; id: string; name?: string | null } | null;
  } | null;
};
export const query = {
  types: [
    "messenger_chat",
    "messenger_message",
    "messenger_call",
    "messenger_call_part",
  ],
  select: { fields: "all" as const, change: true as const },
  orderBy: [{ by: "path" as const, direction: "asc" as const }],
};
let bridge: ReturnType<typeof getHouseBridge> | undefined;
export function houseBridge() {
  if (!bridge) {
    bridge = getHouseBridge();
    bridge.setTab({ title: "Messenger" });
  }
  return bridge;
}
export function houseRuntime() { return houseBridge().runtime; }
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
export class HouseMessengerStore implements Store {
  private state: Snapshot = {
    composerDrafts: {},
    availableDrafts: [],
    chats: [],
    messages: [],
    callParts: [],
    loading: true,
    error: null,
    sync: "",
    busy: false,
    halted: false,
  };
  private listeners = new Set<() => void>();
  private close: (() => void)[] = [];
  private init?: Promise<void>;
  private connectionTimer?: ReturnType<typeof setTimeout>;
  private md?: Runtime;
  private rooms = new Map<string, string>();
  private composerSessions = new Map<string, DraftSession>();
  private localDrafts: readonly RoomDraft[] = [];
  private composerPending = new Map<string, number>();
  private composerWork = new Map<string, Promise<void>>();
  private composerFailed = new Set<string>();
  private fatal: string | null = null;
  private bindingError: string | null = null;
  private refusalError: string | null = null;
  private storageError: string | null = null;
  private ready = false;
  private get blockingError() {
    return this.fatal ?? this.refusalError ?? this.storageError ?? this.bindingError;
  }
  private locked = false;
  private disposed = false;
  constructor(private provider: () => Promise<Runtime> = houseRuntime) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit(patch: Partial<Snapshot>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  private fail(message: string) {
    this.fatal = message;
    this.emit({ loading: false, error: message });
  }
  private read(result: { documents: readonly Document[] }) {
    const chats: Chat[] = [],
      messages: Message[] = [],
      callParts: CallPart[] = [];
    const identities = new Set<string>();
    const calls = new Set<string>();
    for (const doc of result.documents) {
      if (!this.rooms.has(doc.room))
        throw new Error("House returned a document outside the bound Rooms.");
      const key = `${doc.room}/${doc.path}`;
      if (identities.has(key))
        throw new Error("Duplicate House document path.");
      identities.add(key);
      if (doc.type === "messenger_chat") {
        const fields = chatSchema.parse(doc.fields);
        if (doc.path !== "chats/main.md")
          throw new Error(
            "Each Room must contain its single chat at chats/main.md. Private audiences need separate Rooms.",
          );
        chats.push({
          ...fields,
          room: doc.room,
          roomName: this.rooms.get(doc.room)!,
          path: doc.path,
        });
      } else if (doc.type === "messenger_message") {
        const fields = messageSchema.parse(doc.fields);
        if (doc.path !== `messages/${fields.id}.md`)
          throw new Error("Message identity does not match its path.");
        const author = doc.change?.author;
        messages.push({
          ...fields,
          room: doc.room,
          path: doc.path,
          author: author
            ? ({ ...author, name: author.name ?? null } as Author)
            : null,
        });
      } else if (doc.type === "messenger_call") {
        const fields = callSchema.parse(doc.fields);
        if (doc.path !== `calls/${fields.id}.md`)
          throw new Error("Call identity does not match its path.");
        calls.add(`${doc.room}/${fields.id}`);
      } else if (doc.type === "messenger_call_part") {
        const fields = callPartSchema.parse(doc.fields);
        if (doc.path !== `call-parts/${fields.id}.md`)
          throw new Error("Call-part identity does not match its path.");
        callParts.push({ ...fields, room: doc.room, path: doc.path });
      } else throw new Error("Unexpected Messenger document type.");
    }
    for (const item of messages) {
      if (!chats.some((c) => c.room === item.room))
        throw new Error("A message refers to a missing Room chat.");
      if (
        item.reply &&
        !messages.some(
          (m) =>
            m.room === item.room &&
            m.path === `messages/${item.reply!.slice(2)}`,
        )
      )
        throw new Error("A message reply target is unavailable.");
    }
    for (const item of callParts) {
      if (
        !calls.has(`${item.room}/${item.call_id}`) ||
        item.call !== `../calls/${item.call_id}.md`
      )
        throw new Error("A call part refers to an unavailable call.");
      if (
        new Set(item.participants.map((x) => x.id)).size !== 2 ||
        new Set(item.files.map((x) => x.speaker_id)).size !== 2 ||
        item.files.some(
          (x) => !item.participants.some((p) => p.id === x.speaker_id),
        )
      )
        throw new Error("A call part must contain one file per named speaker.");
    }
    this.emit({
      chats,
      messages: messages.sort((a, b) =>
        b.created_at.localeCompare(a.created_at),
      ),
      callParts: callParts.sort((a, b) => a.part - b.part),
      loading: false,
      error: this.blockingError,
    });
  }
  private readComposer(draft: RoomDraft): ComposerDraft | null {
    const creation = draft.parts.creation;
    if (!this.rooms.has(draft.room) || !creation || !("type" in creation) || creation.type !== "messenger_message") return null;
    const fields = creation.fields;
    if (typeof fields.id !== "string" || draft.path !== `messages/${fields.id}.md` || fields.chat !== "../chats/main.md" || typeof fields.text !== "string" || typeof fields.created_at !== "string") return null;
    const attachments = attachmentSchema.array().safeParse(fields.attachments);
    if (!attachments.success) return null;
    return { room: draft.room, path: draft.path, id: fields.id, text: fields.text, created_at: fields.created_at, attachments: attachments.data, ...(typeof fields.reply === "string" ? { reply: fields.reply } : {}) };
  }
  private refreshComposers() {
    if (!this.md || !this.ready) return;
    const available = this.localDrafts.map(draft => this.readComposer(draft)).filter((draft): draft is ComposerDraft => draft !== null).sort((one, two) => two.created_at.localeCompare(one.created_at) || one.path.localeCompare(two.path));
    const next = { ...this.state.composerDrafts };
    for (const room of this.rooms.keys()) {
      if (this.composerPending.get(room) || this.composerFailed.has(room)) continue;
      const current = this.composerSessions.get(room);
      const draft = available.find(item => item.room === room && item.path === current?.path) ?? available.find(item => item.room === room);
      if (draft) {
        if (!current || current.path !== draft.path) this.composerSessions.set(room, new DraftSession(this.md, room, draft.path));
        next[room] = draft;
      } else {
        this.composerSessions.delete(room);
        delete next[room];
      }
    }
    this.emit({ composerDrafts: next, availableDrafts: available });
  }
  selectComposer(room: string, path: string) {
    if (!this.md || this.composerPending.get(room) || this.state.busy) return;
    const draft = this.state.availableDrafts?.find(item => item.room === room && item.path === path);
    if (!draft) return;
    this.composerSessions.set(room, new DraftSession(this.md, room, path));
    this.refreshComposers();
  }
  writeComposer(room: string, text: string, reply?: Message | null): Promise<void> {
    // No schema validation while typing: even incomplete business-field values
    // belong to the actual message creation draft. Only Send validates them.
    const previous = this.state.composerDrafts?.[room];
    const optimistic: ComposerDraft = { room, path: previous?.path ?? "", id: previous?.id ?? "", text, created_at: previous?.created_at ?? "", attachments: previous?.attachments ?? [], ...(reply === undefined && previous?.reply ? { reply: previous.reply } : reply ? { reply: `./${reply.id}.md` } : {}) };
    this.composerPending.set(room, (this.composerPending.get(room) ?? 0) + 1);
    this.emit({ composerDrafts: { ...this.state.composerDrafts, [room]: optimistic } });
    const work = (this.composerWork.get(room) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      await this.start();
      if (!this.md || !this.ready || !this.rooms.has(room)) throw new Error("The message's Room is unavailable for local drafting.");
      let session = this.composerSessions.get(room);
      if (!session) {
        const existing = this.localDrafts.map(draft => this.readComposer(draft)).find(draft => draft?.room === room);
        const id = existing?.id ?? crypto.randomUUID();
        session = new DraftSession(this.md, room, existing?.path ?? `messages/${id}.md`);
        this.composerSessions.set(room, session);
      }
      const id = session.path.slice('messages/'.length, -3);
      await session.stage(current => {
        const creation = current?.parts.creation;
        if (creation && (!("type" in creation) || creation.type !== "messenger_message")) throw new Error("The message draft changed its document type. It has been preserved.");
        const fields = { ...(creation && "fields" in creation ? creation.fields : { id, chat: "../chats/main.md", created_at: new Date().toISOString(), kind: "text", attachments: [] }), text };
        const values: Record<string, unknown> = fields;
        if (reply) values.reply = `./${reply.id}.md`; else if (reply === null) delete values.reply;
        return { creation: { type: "messenger_message", fields: values, sections: creation && "sections" in creation ? creation.sections : {} } };
      });
      this.composerFailed.delete(room);
    }).catch(error => { this.composerFailed.add(room); throw error; }).finally(() => {
      this.composerPending.set(room, (this.composerPending.get(room) ?? 1) - 1);
      this.refreshComposers();
    });
    this.composerWork.set(room, work);
    return work;
  }
  start() {
    if (this.disposed) return Promise.resolve();
    this.init ??= this.connect();
    return this.init;
  }
  private ownObservation(
    watch: { subscribe(listener: () => void): () => void; close(): void },
    render: () => void,
  ): boolean {
    let released = false;
    let unsubscribe: (() => void) | undefined;
    const close = () => {
      if (released) return;
      released = true;
      try {
        unsubscribe?.();
      } finally {
        watch.close();
      }
    };
    if (this.disposed) {
      close();
      return false;
    }
    // Own the observation before subscribing or rendering: either may notify a
    // view synchronously, and that view can dispose the store during the call.
    this.close.push(close);
    const update = () => {
      if (!this.disposed && !released) render();
    };
    try {
      const off = watch.subscribe(update);
      if (released) {
        off();
        return false;
      }
      unsubscribe = off;
      update();
      return !this.disposed;
    } catch (error) {
      close();
      throw error;
    }
  }
  private async connect() {
    const timer = (this.connectionTimer = setTimeout(
      () =>
        this.emit({
          loading: false,
          error:
            "Open Messenger inside House with its Room bindings. House has not supplied the runtime.",
        }),
      15000,
    ));
    try {
      this.md = await this.provider();
      if (this.disposed) return;
      // rooms() is a local snapshot, initially empty. Both observations must
      // stay alive so a completed sync and a later binding can recover in-place.
      const bindings = await this.md.observe("rooms");
      if (this.disposed) { bindings.close(); return; }
      let syncComplete = false;
      let guardsReady = false;
      let queryKey = "";
      let queryGeneration = 0;
      let renderQuery: (() => void) | undefined;
      let releaseQuery: (() => void) | undefined;
      const refresh = async () => {
        if (this.disposed) return;
        const next = bindings.current();
        this.ready = guardsReady && syncComplete && next.length > 0;
        this.bindingError = syncComplete && !next.length
          ? "Room bindings changed or are missing. Bind a Messenger Room in House. Different private audiences must use separate Rooms."
          : null;
        if (!this.ready) {
          this.emit({ loading: !syncComplete, error: this.blockingError });
          return;
        }
        const key = JSON.stringify(next.map(room => room.locator).sort());
        this.rooms = new Map(next.map(room => [room.locator, room.name]));
        if (key === queryKey) {
          renderQuery?.();
          return;
        }
        queryKey = key;
        const generation = ++queryGeneration;
        releaseQuery?.();
        renderQuery = undefined;
        this.emit({ loading: true, error: this.blockingError });
        try {
          const watch = await this.md!.observe("query", {
            ...query, rooms: [...this.rooms.keys()],
          });
          if (this.disposed || generation !== queryGeneration) { watch.close(); return; }
          let released = false;
          const subscription: { unsubscribe?: () => void } = {};
          releaseQuery = () => {
            if (released) return;
            released = true;
            subscription.unsubscribe?.();
            watch.close();
          };
          this.close.push(releaseQuery);
          renderQuery = () => {
            if (this.disposed || released || generation !== queryGeneration || !this.ready) return;
            try {
              const result = watch.current();
              if ("pending" in result) return;
              this.read(result);
            }
            catch (e) { this.emit({ loading: false, error: this.blockingError ?? errorText(e) }); }
          };
          const off = watch.subscribe(renderQuery);
          if (released) { off(); return; }
          subscription.unsubscribe = off;
          renderQuery();
        } catch (e) {
          if (!this.disposed && generation === queryGeneration)
            this.emit({ loading: false, error: this.blockingError ?? errorText(e) });
        }
      };
      if (!this.ownObservation(bindings, () => { void refresh(); })) return;
      const status = await this.md.observe("sync-status");
      const showSync = () => {
        const value = status.current();
        syncComplete = value.lastCompleted !== null && value.lastCompleted !== undefined;
        this.emit({ sync: value.attentionRequired.length ? "House drafts need attention" : "" });
        void refresh();
      };
      if (!this.ownObservation(status, showSync)) return;
      const mode = await this.md.observe("service-mode");
      if (!this.ownObservation(mode, () => this.emit({ halted: mode.current() === "write-halted" }))) return;
      const refusal = await this.md.observe("connection-refusal");
      if (!this.ownObservation(refusal, () => {
        this.refusalError = refusal.current() ? "House authorization changed. Reopen the App before continuing." : null;
        void refresh();
      })) return;
      const loss = await this.md.observe("storage-loss");
      if (!this.ownObservation(loss, () => {
        this.storageError = loss.current() ? "House reports lost unsynchronized changes. Check the Room before continuing." : null;
        void refresh();
      })) return;
      const drafts = await this.md.observe("room-drafts");
      if (!this.ownObservation(drafts, () => {
        this.localDrafts = drafts.current();
        this.composerSessions.forEach(session => session.accept(this.localDrafts.find(draft => draft.room === session.room && draft.path === session.path) ?? null));
        this.refreshComposers();
      })) return;
      guardsReady = true;
      await refresh();
      this.refreshComposers();
    } catch (e) {
      this.emit({ loading: false, error: errorText(e) });
    } finally {
      clearTimeout(timer);
      if (this.connectionTimer === timer) this.connectionTimer = undefined;
    }
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.connectionTimer);
    this.connectionTimer = undefined;
    this.listeners.clear();
    for (const close of this.close.splice(0)) {
      try {
        close();
      } catch {
        // Release the remaining observations even if one cleanup fails.
      }
    }
  }
  private async create(
    room: string,
    path: string,
    type: string,
    fields: Record<string, unknown>,
  ) {
    if (this.locked) throw new Error("A save is already in progress.");
    this.locked = true;
    this.emit({ busy: true });
    try {
      await this.start();
      if (!this.ready) throw new Error(this.blockingError ?? "Loading Messenger Rooms…");
      if (this.state.error) throw new Error(this.state.error);
      if (!this.md || !this.rooms.has(room))
        throw new Error("That Room is not bound.");
      if (await this.md.roomDraft.read(room, path))
        throw new Error(
          "An unfinished House draft already exists for this document. Resolve it in House.",
        );
      const result = await this.md.roomDraft.write(room, path, null, {
        creation: { type, fields, sections: {} },
      });
      if (result.outcome !== "written" || !result.roomDraft)
        throw new Error(
          "The House draft changed. Your composer is preserved; inspect the draft before retrying.",
        );
      const saved = await this.md.save(room, [
        { path, revision: result.roomDraft.revision },
      ]);
      if (saved.outcome !== "saved")
        throw new Error(
          `House refused the save (${saved.outcome}). Your composer and House draft are preserved; inspect before retrying.`,
        );
      this.read(
        await this.md.query({ ...query, rooms: [...this.rooms.keys()] }),
      );
    } finally {
      this.locked = false;
      this.emit({ busy: false });
    }
  }
  async send(room: string, text: string, reply?: Message, files: File[] = []) {
    await this.start();
    if (!this.ready || !this.rooms.has(room)) throw new Error(this.blockingError ?? "Room bindings changed. Select an available Room chat.");
    const chat = this.state.chats.find((c) => c.room === room);
    if (!chat) throw new Error("Select an existing Room chat.");
    if (
      reply &&
      (reply.room !== room ||
        !this.state.messages.some((m) => m.room === room && m.id === reply.id))
    )
      throw new Error("The reply target is not in this Room.");
    if (files.length && this.state.halted) throw new Error("House attachment uploads are paused. Your message draft is preserved.");
    if (files.length > 8) throw new Error("Attach at most eight files.");
    if (this.locked || this.state.busy)
      throw new Error("A send is already in progress.");
    if (!this.ready || this.state.error || !this.md)
      throw new Error(this.state.error ?? "House is not writable.");
    if (!text.trim() && !files.length)
      throw new Error("Write a message or attach a file.");
    // Reject correctable input before acquiring the send lock or uploading bytes.
    const body = messageSchema.shape.text.parse(text.trim());
    for (const file of files) {
      attachmentSchema.omit({ path: true, sha256: true }).parse({
        name: file.name,
        mime: file.type || "application/octet-stream",
        bytes: file.size,
      });
      if (!file.name.trim() || file.size === 0 || file.size > MAX_FILE_BYTES)
        throw new Error("Choose a nonempty named file of at most 20 MiB.");
    }
    this.emit({ busy: true });
    try {
      await this.composerWork.get(room);
      const composer = this.composerSessions.get(room);
      const prepared = await composer?.read();
      const priorCreation = prepared?.parts.creation;
      const existingAttachments = priorCreation && "fields" in priorCreation && Array.isArray(priorCreation.fields.attachments) ? priorCreation.fields.attachments : [];
      const id = composer ? composer.path.slice("messages/".length, -3) : crypto.randomUUID();
      const attachments = [];
      try {
        for (const file of files)
          attachments.push(await uploadAttachment(this.md, room, file));
      } catch (e) {
        this.fail(
          "File upload outcome needs review. Do not resend automatically: " +
            errorText(e),
        );
        throw e;
      }
      const allAttachments = [...existingAttachments, ...attachments];
      const fields = messageSchema.parse({
        id,
        chat: "../chats/main.md",
        text: body,
        created_at: new Date().toISOString(),
        kind:
          allAttachments.length === 1 && attachmentSchema.parse(allAttachments[0]).mime.startsWith("audio/")
            ? "voice"
            : allAttachments.length
              ? "file"
              : "text",
        attachments: allAttachments,
        ...(reply ? { reply: `./${reply.id}.md` } : {}),
      });
      try {
        if (composer) {
          await composer.stage(current => {
            const creation = current?.parts.creation;
            if (!creation || !("type" in creation) || creation.type !== "messenger_message") throw new Error("The prepared message draft is no longer available.");
            return { creation: { ...creation, fields } };
          });
          await composer.commit();
          this.read(await this.md!.query({ ...query, rooms: [...this.rooms.keys()] }));
        } else await this.create(room, `messages/${id}.md`, "messenger_message", fields);
      } catch (e) {
        this.fail(
          "Message save needs review in House before another send. The composer is preserved. " +
            errorText(e),
        );
        throw e;
      }
    } finally {
      this.emit({ busy: false });
    }
  }
  async initialize(room: string, title: string) {
    await this.start();
    if (this.state.chats.some((c) => c.room === room))
      throw new Error("This Room already has a chat.");
    const fields = chatSchema.parse({
      id: crypto.randomUUID(),
      title,
      mode: "room",
      created_at: new Date().toISOString(),
    });
    await this.create(room, "chats/main.md", "messenger_chat", fields);
  }
}
