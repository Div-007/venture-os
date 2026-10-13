"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { AttachmentKind, SharedAttachment } from "@venture-studio/contracts";
import { describeError } from "@/lib/errors";
import { listLiveGroupAttachments, listLiveTaskAttachments, type loadLiveSession } from "@/lib/studio-api";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/select";
import { FolderOpen, Paperclip } from "@/components/ui/icons";
import { Field, filterControl, inputClass, Notice, Panel, secondaryClass, SkeletonRows } from "@/components/studio/primitives";
import { ImageTile, ImageViewer, MessageAttachmentCard } from "@/components/studio/chat-attachments";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Page = { items: SharedAttachment[]; nextCursor?: string };

const KINDS: Array<{ key: AttachmentKind | ""; label: string }> = [{ key: "", label: "All" }, { key: "image", label: "Photos" }, { key: "video", label: "Videos" }, { key: "audio", label: "Audio" }, { key: "document", label: "Documents" }];
const isImage = (file: SharedAttachment) => /^image\/(png|jpeg|webp|gif)$/.test(file.contentType);
const when = (iso: string) => new Intl.DateTimeFormat("en", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

function KindFilter({ value, onChange }: { value: AttachmentKind | ""; onChange: (value: AttachmentKind | "") => void }) {
  return <div role="group" aria-label="File type" className="flex flex-wrap gap-2">{KINDS.map((kind) => <button key={kind.key} type="button" aria-pressed={value === kind.key} onClick={() => onChange(kind.key)} className={filterControl(value === kind.key)}>{kind.label}</button>)}</div>;
}

/** Newest first: photos as a grid that opens full size, then videos, audio, and documents as cards with preview and download. */
function SharedFiles({ items, caption }: { items: SharedAttachment[]; caption: (file: SharedAttachment) => React.ReactNode }) {
  const images = useMemo(() => items.filter(isImage), [items]);
  const others = useMemo(() => items.filter((file) => !isImage(file)), [items]);
  const [open, setOpen] = useState<number | null>(null);
  return <div className="space-y-6">
    {images.length > 0 && <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 2xl:grid-cols-6">{images.map((file, index) => <figure key={`${file.messageId ?? file.taskId}-${file.id}`} className="min-w-0">
      <ImageTile file={file} className="aspect-square w-full" onOpen={() => setOpen(index)} />
      <figcaption className="mt-1.5 line-clamp-2 text-[11px] leading-4 text-neutral-500">{caption(file)}</figcaption>
    </figure>)}</div>}
    {others.length > 0 && <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{others.map((file) => <div key={`${file.messageId ?? file.taskId}-${file.id}`} className="min-w-0">
      <MessageAttachmentCard file={file} />
      <p className="mt-1.5 line-clamp-2 px-1 text-[11px] leading-4 text-neutral-500">{caption(file)}</p>
    </div>)}</div>}
    {open !== null && <ImageViewer images={images} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
  </div>;
}

function usePages(load: (cursor?: string) => Promise<Page>, key: string) {
  const [state, setState] = useState<{ key: string; items: SharedAttachment[]; nextCursor?: string; loading: boolean; error: string }>({ key, items: [], loading: true, error: "" });
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setState({ key, items: [], loading: true, error: "" });
      load().then((page) => { if (active) setState({ key, items: page.items, nextCursor: page.nextCursor, loading: false, error: "" }); })
        .catch((cause: unknown) => { if (active) setState({ key, items: [], loading: false, error: describeError(cause, "Couldn't load these files.") }); });
    });
    return () => { active = false; };
    // `key` names everything `load` depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const current = state.key === key ? state : { key, items: [], loading: true, error: "", nextCursor: undefined };
  async function more() {
    if (!current.nextCursor || current.loading) return;
    setState((value) => ({ ...value, loading: true }));
    try {
      const page = await load(current.nextCursor);
      setState((value) => value.key === key ? { ...value, items: [...value.items, ...page.items], nextCursor: page.nextCursor, loading: false } : value);
    } catch (cause) { setState((value) => value.key === key ? { ...value, loading: false, error: describeError(cause, "Couldn't load more files.") } : value); }
  }
  return { ...current, more, dismiss: () => setState((value) => ({ ...value, error: "" })) };
}

function Results({ pages, empty, caption }: { pages: ReturnType<typeof usePages>; empty: { title: string; body: string }; caption: (file: SharedAttachment) => React.ReactNode }) {
  return <>
    <Notice tone="error" message={pages.error} onDismiss={pages.dismiss} className="pb-4" />
    {pages.loading && !pages.items.length ? <SkeletonRows rows={4} label="Loading files" className="!p-0" />
      : !pages.items.length ? !pages.error && <EmptyState variant="compact" icon={Paperclip} title={empty.title} body={empty.body} />
      : <SharedFiles items={pages.items} caption={caption} />}
    {pages.nextCursor && <div className="mt-6"><button type="button" disabled={pages.loading} onClick={() => void pages.more()} className={secondaryClass}>{pages.loading ? "Loading…" : "Load older files"}</button></div>}
  </>;
}

/** Every file attached to a task I can open, newest first, with the task it belongs to. */
export function TaskFilesPanel({ ventureId, nameOf }: { ventureId: string; nameOf: (id: string) => string }) {
  const [kind, setKind] = useState<AttachmentKind | "">("");
  const pages = usePages((cursor) => listLiveTaskAttachments({ ventureId: ventureId || undefined, kind: kind || undefined, cursor }), `${ventureId}|${kind}`);
  return <Panel className="p-4 sm:p-5">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-bold text-neutral-900">Task files</h2><p className="mt-0.5 text-xs text-neutral-500">Everything attached to tasks, newest first. Add files on the task itself.</p></div><KindFilter value={kind} onChange={setKind} /></div>
    <Results pages={pages} empty={{ title: kind ? "No files of this type" : "No task files yet", body: "Files attached to tasks show up here." }}
      caption={(file) => <><Link href={`/tasks/live?task=${encodeURIComponent(file.taskId ?? "")}`} className="font-semibold text-neutral-700 hover:text-primary-700 hover:underline">{file.taskTitle ?? "Task"}</Link> · {nameOf(file.sharedBy)} · {when(file.sharedAt)}</>} />
  </Panel>;
}

/** Everything shared in a group's channels (or one channel), newest first. */
export function ChatFilesPanel({ session, ventureId, nameOf }: { session: Session; ventureId: string; nameOf: (id: string) => string }) {
  const groups = useMemo(() => session.hierarchy.ventures.filter((venture) => !ventureId || venture.id === ventureId).flatMap((venture) => venture.groups.map((group) => ({ ...group, ventureName: venture.name }))), [session, ventureId]);
  const [chosenGroup, setGroupId] = useState("");
  const groupId = groups.some((group) => group.id === chosenGroup) ? chosenGroup : groups[0]?.id ?? "";
  const group = groups.find((item) => item.id === groupId);
  const [chosenChannel, setChannelId] = useState("");
  const channelId = group?.channels.some((channel) => channel.id === chosenChannel) ? chosenChannel : "";
  const [kind, setKind] = useState<AttachmentKind | "">("");
  const channelName = (id?: string) => group?.channels.find((channel) => channel.id === id)?.name;
  const pages = usePages((cursor) => groupId ? listLiveGroupAttachments(groupId, { channelId: channelId || undefined, kind: kind || undefined, cursor }) : Promise.resolve({ items: [] }), `${groupId}|${channelId}|${kind}`);
  if (!groups.length) return <Panel className="p-4 sm:p-5"><EmptyState variant="compact" icon={FolderOpen} title="No groups here" body="Files shared in the chats of groups you belong to show up here." /></Panel>;
  return <Panel className="p-4 sm:p-5">
    <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:max-w-2xl">
      <Field label="Group"><Select className={inputClass} value={groupId} onChange={(event) => { setGroupId(event.target.value); setChannelId(""); }}>{groups.map((item) => <option key={item.id} value={item.id}>{ventureId ? item.name : `${item.ventureName} · ${item.name}`}</option>)}</Select></Field>
      <Field label="Channel"><Select className={inputClass} value={channelId} onChange={(event) => setChannelId(event.target.value)}><option value="">All channels</option>{group?.channels.map((channel) => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}</Select></Field>
    </div>
    <div className="mb-5"><KindFilter value={kind} onChange={setKind} /></div>
    <Results pages={pages} empty={{ title: kind ? "No files of this type" : "Nothing shared yet", body: channelId ? "Photos, videos, and files shared in this channel show up here." : "Photos, videos, and files shared in this group's channels show up here." }}
      caption={(file) => <>{nameOf(file.sharedBy)} · <Link href={`/channels/live?channel=${encodeURIComponent(file.channelId ?? "")}`} className="font-semibold text-neutral-700 hover:text-primary-700 hover:underline">#{channelName(file.channelId) ?? "channel"}</Link> · {when(file.sharedAt)}</>} />
  </Panel>;
}
