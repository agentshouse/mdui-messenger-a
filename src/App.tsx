import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ArrowLeft,
  FileText,
  MessageCircle,
  Mic,
  Moon,
  Phone,
  Reply,
  Search,
  Send,
  Square,
  Sun,
  Video,
  X,
} from "lucide-react";
import { Chat } from "@/registry/new-york/chat/chat";
import {
  ChatHeader,
  ChatHeaderAddon,
  ChatHeaderAvatar,
  ChatHeaderButton,
  ChatHeaderMain,
} from "@/registry/new-york/chat/chat-header";
import { ChatMessages } from "@/registry/new-york/chat/chat-messages";
import {
  ChatEvent,
  ChatEventAddon,
  ChatEventAvatar,
  ChatEventBody,
  ChatEventContent,
  ChatEventHoverActions,
  ChatEventHoverActionsButton,
  ChatEventTime,
  ChatEventTitle,
} from "@/registry/new-york/chat/chat-event";
import {
  ChatToolbar,
  ChatToolbarAddon,
  ChatToolbarAttachment,
  ChatToolbarAttachmentButton,
  ChatToolbarButton,
  ChatToolbarTextarea,
} from "@/registry/new-york/chat/chat-toolbar";
import { Input } from "./components/ui/input";
import { Button } from "./components/ui/button";
import { Attachment } from "./components/Attachment";
import { CallWorkspace } from "./components/CallWorkspace";
import { HouseMessengerStore, houseBridge } from "./data/house";
import { type Store, type Message } from "./data/model";
import { ChatNavigation } from "./navigation";
import { VoiceCapture } from "./call/voiceCapture";
const productionStore = new HouseMessengerStore();
const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((s) => s[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
export function App({ store = productionStore, navigation: suppliedNavigation }: { store?: Store; navigation?: ChatNavigation }) {
  const navigation = useMemo(() => suppliedNavigation ?? (store === productionStore ? new ChatNavigation(houseBridge()) : null), [suppliedNavigation, store]);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [routeReady, setRouteReady] = useState(!navigation);

  const state = useSyncExternalStore(store.subscribe, store.snapshot),
    [room, setRoom] = useState<string | null>(null),
    [filter, setFilter] = useState(""),
    [search, setSearch] = useState(""),
    [dark, setDark] = useState(false),
    [callOpen, setCallOpen] = useState(false),
    [notice, setNotice] = useState(""),
    [recording, setRecording] = useState(false),
    [startingVoice, setStartingVoice] = useState(false);
  const [drafts, setDrafts] = useState<
    Record<string, { text: string; reply?: Message; files: File[] }>
  >({});
  const capture = useRef<VoiceCapture | null>(null),
    sendLock = useRef(false),
    mounted = useRef(true),
    voiceRoom = useRef<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    void store.start();
    return () => {
      mounted.current = false;
      capture.current?.cancel();
      store.dispose();
    };
  }, [store]);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    return () => document.documentElement.classList.remove("dark");
  }, [dark]);
  const selected = state.chats.find((c) => c.room === room),
    shared = room ? state.composerDrafts?.[room] : undefined,
    draft = room
      ? { ...(drafts[room] ?? { text: "", files: [] }), ...(shared ? { text: shared.text, reply: state.messages.find(message => message.room === room && `./${message.id}.md` === shared.reply) } : {}) }
      : { text: "", files: [] };
  const messages = useMemo(
    () =>
      state.messages.filter(
        (m) =>
          m.room === room &&
          (!search ||
            m.text.toLocaleLowerCase().includes(search.toLocaleLowerCase())),
      ),
    [state.messages, room, search],
  );
  const setDraft = (change: Partial<typeof draft>) => {
    if (!room) return;
    const next = { ...draft, ...change };
    setDrafts(old => ({ ...old, [room]: next }));
    if (store.writeComposer && (Object.hasOwn(change, "text") || Object.hasOwn(change, "reply"))) {
      void store.writeComposer(room, next.text, Object.hasOwn(change, "reply") ? next.reply ?? null : undefined).catch(error => {
        if (mounted.current) setNotice(error instanceof Error ? error.message : String(error));
      });
    }
  };
  const applySelection = useCallback((next: string | null) => {
    capture.current?.cancel();
    capture.current = null;
    setRecording(false);
    setStartingVoice(false);
    voiceRoom.current = null;
    setRoom(next);
    setSearch("");
    setNotice("");
  }, []);
  useEffect(() => {
    if (!navigation) return;
    let previous: string | null | undefined;
    const apply = () => {
      const route = navigation.snapshot();
      setNavigationError(route.error);
      setRouteReady(route.ready);
      if (route.ready && route.room !== previous) {
        previous = route.room;
        applySelection(route.room);
      }
    };
    const unsubscribe = navigation.subscribe(apply);
    apply();
    return unsubscribe;
  }, [navigation, applySelection]);
  const select = (next: string | null) => {
    if (navigation) navigation.navigate(next);
    else applySelection(next);
  };
  const submit = async () => {
    if (
      !room ||
      !selected ||
      state.error ||
      (state.halted && draft.files.length > 0) ||
      state.busy ||
      recording ||
      startingVoice ||
      sendLock.current
    )
      return;
    const target = room;
    const opened = draft;
    if (!opened.text.trim() && !opened.files.length) return;
    sendLock.current = true;
    setNotice("");
    try {
      await store.send(target, opened.text, opened.reply, opened.files);
      if (mounted.current)
        setDrafts((old) => ({
          ...old,
          [target]:
            (old[target]?.text === opened.text && old[target]?.files === opened.files) ? { text: "", files: [] } : old[target],
        }));
    } catch (e) {
      if (mounted.current)
        setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      sendLock.current = false;
    }
  };
  const toggleVoice = async () => {
    if (!room || state.busy) return;
    if (recording) {
      const current = capture.current;
      const target = room;
      try {
        const file = await current!.stop();
        if (
          mounted.current &&
          capture.current === current &&
          voiceRoom.current === target
        )
          setDrafts((old) => ({
            ...old,
            [target]: {
              ...(old[target] ?? { text: "", files: [] }),
              files: [...(old[target]?.files ?? []), file],
            },
          }));
      } catch (e) {
        if (mounted.current && capture.current === current)
          setNotice(e instanceof Error ? e.message : String(e));
      } finally {
        if (capture.current === current) {
          setRecording(false);
          capture.current = null;
        }
      }
      return;
    }
    setNotice("");
    setStartingVoice(true);
    voiceRoom.current = room;
    const recorder = new VoiceCapture();
    capture.current = recorder;
    try {
      await recorder.start();
      if (
        mounted.current &&
        capture.current === recorder &&
        voiceRoom.current === room
      )
        setRecording(true);
    } catch (e) {
      if (mounted.current && capture.current === recorder)
        setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current && capture.current === recorder)
        setStartingVoice(false);
    }
  };
  const parts = state.callParts.filter((p) => p.room === room);
  return (
    <div className={dark ? "dark messenger-app" : "messenger-app"}>
      {navigationError && <div role="alert" className="p-3 text-sm text-destructive">{navigationError}</div>}
      <div className="messenger-shell bg-background text-foreground border shadow-sm">
        <aside
          className={`chat-list border-r ${room ? "mobile-hidden" : ""}`}
          aria-label="Chats"
        >
          <div className="p-4 flex justify-between items-center">
            <h1 className="font-semibold text-xl flex items-center gap-2">
              <MessageCircle size={22} />
              Messenger
            </h1>
            <Button
              size="icon"
              variant="ghost"
              aria-label={dark ? "Use light theme" : "Use dark theme"}
              onClick={() => setDark(!dark)}
            >
              {dark ? <Sun /> : <Moon />}
            </Button>
          </div>
          <div className="px-3 pb-3">
            <label className="sr-only" htmlFor="chat-filter">
              Find a chat
            </label>
            <Input
              id="chat-filter"
              placeholder="Find a chat…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {state.chats
              .filter((c) =>
                c.title
                  .toLocaleLowerCase()
                  .includes(filter.toLocaleLowerCase()),
              )
              .map((chat) => {
                const latest = state.messages.find((m) => m.room === chat.room);
                return (
                  <button
                    className={`chat-list-item ${room === chat.room ? "bg-accent" : ""}`}
                    aria-label={`Open ${chat.title} chat`}
                    key={chat.room}
                    onClick={() => select(chat.room)}
                  >
                    <span className="chat-initials">
                      {initials(chat.title)}
                    </span>
                    <span className="min-w-0 flex-1 text-left">
                      <span className="font-medium block truncate">
                        {chat.title}
                      </span>
                      <span className="text-xs text-muted-foreground block truncate">
                        {latest?.text ||
                          `${chat.mode === "direct" ? "Direct" : chat.mode === "group" ? "Group" : "Room"} chat`}
                      </span>
                    </span>
                  </button>
                );
              })}
            {!state.loading && !state.chats.length && (
              <p className="text-sm text-muted-foreground p-3">
                No Room chats yet. Bind a Room containing a Messenger chat in
                House.
              </p>
            )}
          </div>
          <div className="p-3 border-t text-xs text-muted-foreground">
            {state.loading && <p role="status">Loading messages…</p>}
            {state.sync && <p role="alert">{state.sync}</p>}
            {state.halted && <p role="alert">House writes are paused. Text messages still queue locally; attachment uploads wait for writes to reopen.</p>}
            <a
              className="underline mt-2 inline-block"
              href="./THIRD_PARTY_NOTICES.txt"
              target="_blank"
              rel="noreferrer"
            >
              Licenses
            </a>
          </div>
        </aside>
        <main className={`chat-main ${!room ? "mobile-hidden" : ""}`}>
          {state.error && (
            <div role="alert" className="border-b p-3 text-sm text-destructive">
              {state.error}
            </div>
          )}
          {!selected ? (
            <div className="empty-chat">
              <MessageCircle size={46} />
              <h2 className="text-lg font-semibold mt-3">
                {room ? (!routeReady || state.loading ? "Opening conversation" : "Conversation unavailable") : "Your conversations"}
              </h2>
              <p className="text-muted-foreground text-sm mt-1">
                {!routeReady || state.loading ? "Loading conversation…" : room ? "This linked conversation is not available in the connected Rooms." : "Choose a chat to read messages, reply or share a voice note."}
              </p>
              {room && <Button onClick={() => select(null)}>Back to chats</Button>}
            </div>
          ) : (
            <Chat className="h-full min-h-0">
              <ChatHeader className="border-b">
                <ChatHeaderAddon>
                  <ChatHeaderButton
                    className="mobile-back"
                    aria-label="Back to chats"
                    onClick={() => select(null)}
                  >
                    <ArrowLeft />
                  </ChatHeaderButton>
                  <ChatHeaderAvatar fallback={initials(selected.title)} />
                </ChatHeaderAddon>
                <ChatHeaderMain>
                  <span className="font-medium truncate">{selected.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {selected.mode === "room"
                      ? "Room chat"
                      : selected.mode === "direct"
                        ? "Direct chat"
                        : "Group chat"}
                  </span>
                </ChatHeaderMain>
                <ChatHeaderAddon>
                  <ChatHeaderButton
                    aria-label="Audio call"
                    onClick={() => setCallOpen(true)}
                  >
                    <Phone />
                  </ChatHeaderButton>
                  <ChatHeaderButton
                    aria-label="Video call"
                    onClick={() => setCallOpen(true)}
                  >
                    <Video />
                  </ChatHeaderButton>
                </ChatHeaderAddon>
              </ChatHeader>
              <div className="px-3 py-2 border-b flex gap-2 items-center">
                <Search size={16} />
                <Input
                  aria-label="Search messages"
                  placeholder="Search this chat…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-8"
                />
              </div>
              <ChatMessages className="py-3">
                {messages.map((message, index) => {
                  const previous = messages[index + 1],
                    same =
                      previous?.author?.id &&
                      previous.author.id === message.author?.id &&
                      previous.created_at.slice(0, 10) ===
                        message.created_at.slice(0, 10);
                  const name = message.author?.name ?? "Author unavailable";
                  const replied = message.reply
                    ? state.messages.find(
                        (m) =>
                          m.room === message.room &&
                          m.path === `messages/${message.reply!.slice(2)}`,
                      )
                    : undefined;
                  return (
                    <ChatEvent
                      key={message.id}
                      className={`hover:bg-accent ${same ? "" : "mt-4"}`}
                      id={`message-${message.id}`}
                    >
                      <ChatEventAddon>
                        {same ? (
                          <ChatEventTime
                            timestamp={Date.parse(message.created_at)}
                            format="time"
                            className="text-[10px] text-right"
                          />
                        ) : (
                          <ChatEventAvatar fallback={initials(name)} />
                        )}
                      </ChatEventAddon>
                      <ChatEventBody>
                        {!same && (
                          <ChatEventTitle>
                            <span className="font-medium">{name}</span>
                            <ChatEventTime
                              timestamp={Date.parse(message.created_at)}
                            />
                            <span className="sr-only">
                              Last written by {name}
                            </span>
                          </ChatEventTitle>
                        )}
                        {replied && (
                          <button
                            className="reply-preview"
                            onClick={() =>
                              document
                                .getElementById(`message-${replied.id}`)
                                ?.scrollIntoView({
                                  block: "center",
                                  behavior: "smooth",
                                })
                            }
                          >
                            <Reply size={12} />
                            <span className="truncate">
                              {replied.text || "Attachment"}
                            </span>
                          </button>
                        )}
                        <ChatEventContent className="whitespace-pre-wrap break-words">
                          {message.text}
                          {message.attachments.map((file) => (
                            <Attachment
                              key={file.path}
                              file={file}
                              room={message.room}
                            />
                          ))}
                        </ChatEventContent>
                      </ChatEventBody>
                      <ChatEventHoverActions>
                        <ChatEventHoverActionsButton
                          aria-label={`Reply to message ${message.id}`}
                          onClick={() => setDraft({ reply: message })}
                        >
                          <Reply />
                        </ChatEventHoverActionsButton>
                      </ChatEventHoverActions>
                    </ChatEvent>
                  );
                })}
                {!messages.length && (
                  <p className="text-sm text-muted-foreground text-center p-4">
                    {search
                      ? "No matching messages."
                      : "No messages in this Room yet."}
                  </p>
                )}
              </ChatMessages>
              {parts.length > 0 && (
                <details className="border-t px-3 py-2 text-sm">
                  <summary className="cursor-pointer">
                    Recorded call parts ({parts.length})
                  </summary>
                  <div className="max-h-60 overflow-auto space-y-3 pt-2">
                    {parts.map((part) => (
                      <article key={part.id}>
                        <strong>Part {part.part}</strong> ·{" "}
                        {Math.round(part.duration_ms / 1000)} seconds ·{" "}
                        {part.participants.map((p) => p.name).join(" and ")}
                        {part.files.map((file) => (
                          <Attachment
                            key={file.speaker_id}
                            file={file}
                            room={part.room}
                          />
                        ))}
                      </article>
                    ))}
                  </div>
                </details>
              )}
              {notice && (
                <p className="text-sm text-destructive px-3 py-2" role="alert">
                  {notice}
                </p>
              )}
              <ChatToolbar>
                {(state.availableDrafts?.filter(item => item.room === room).length ?? 0) > 1 && (
                  <ChatToolbarAddon align="block-start">
                    <select aria-label="Local message drafts" value={shared?.path ?? ""} disabled={state.busy || draft.files.length > 0} onChange={event => { if (room) store.selectComposer?.(room, event.target.value); }}>
                      {state.availableDrafts?.filter(item => item.room === room).map(item => <option key={item.path} value={item.path}>{item.text.slice(0, 60) || "Empty message draft"}</option>)}
                    </select>
                  </ChatToolbarAddon>
                )}
                {!!shared?.attachments.length && <ChatToolbarAddon align="block-start"><span>Files kept in this local message draft: {shared.attachments.map(file => file.name).join(", ")}</span></ChatToolbarAddon>}
                {draft.reply && (
                  <ChatToolbarAddon align="block-start">
                    <div className="reply-preview flex-1">
                      <Reply size={14} />
                      <span className="truncate">
                        {draft.reply.text || "Attachment"}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Cancel reply"
                        onClick={() => setDraft({ reply: undefined })}
                      >
                        <X />
                      </Button>
                    </div>
                  </ChatToolbarAddon>
                )}
                {draft.files.length > 0 && (
                  <ChatToolbarAddon
                    align="block-start"
                    className="gap-1 flex-wrap"
                  >
                    {draft.files.map((file, i) => (
                      <ChatToolbarAttachment
                        key={i}
                        fileName={file.name}
                        onRemove={() =>
                          setDraft({
                            files: draft.files.filter((_, j) => j !== i),
                          })
                        }
                      />
                    ))}
                  </ChatToolbarAddon>
                )}
                <ChatToolbarAddon align="inline-start">
                  <ChatToolbarAttachmentButton
                    aria-label="Attach files"
                    disabled={
                      state.busy ||
                      recording ||
                      startingVoice ||
                      draft.files.length >= 8
                    }
                    onFilesSelected={(files) =>
                      setDraft({
                        files: [...draft.files, ...files].slice(0, 8),
                      })
                    }
                  >
                    <FileText />
                  </ChatToolbarAttachmentButton>
                  <ChatToolbarButton
                    aria-label={
                      recording
                        ? "Stop voice recording"
                        : "Record voice message"
                    }
                    disabled={
                      state.busy || startingVoice || draft.files.length >= 8
                    }
                    variant={recording ? "destructive" : "ghost"}
                    onClick={() => void toggleVoice()}
                  >
                    {recording ? <Square /> : <Mic />}
                  </ChatToolbarButton>
                </ChatToolbarAddon>
                <ChatToolbarTextarea
                  aria-label="Message"
                  value={draft.text}
                  disabled={state.busy}
                  onChange={(e) => setDraft({ text: e.target.value })}
                  onSubmit={() => void submit()}
                />
                <ChatToolbarAddon align="inline-end">
                  <ChatToolbarButton
                    aria-label="Send message"
                    variant="default"
                    disabled={
                      state.busy ||
                      (state.halted && draft.files.length > 0) ||
                      !!state.error ||
                      recording ||
                      startingVoice ||
                      (!draft.text.trim() && !draft.files.length)
                    }
                    onClick={() => void submit()}
                  >
                    <Send />
                  </ChatToolbarButton>
                </ChatToolbarAddon>
                {(recording || startingVoice) && (
                  <ChatToolbarAddon align="block-end">
                    <span className="text-xs">
                      {startingVoice
                        ? "Waiting for microphone permission…"
                        : "Recording locally, up to 60 seconds. Stop to review; Send uploads it."}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        capture.current?.cancel();
                        capture.current = null;
                        setRecording(false);
                        setStartingVoice(false);
                        voiceRoom.current = null;
                      }}
                    >
                      Discard recording
                    </Button>
                  </ChatToolbarAddon>
                )}
              </ChatToolbar>
            </Chat>
          )}
        </main>
      </div>
      <CallWorkspace
        rooms={state.chats}
        preferredRoom={room}
        open={callOpen}
        onOpenChange={setCallOpen}
      />
    </div>
  );
}
