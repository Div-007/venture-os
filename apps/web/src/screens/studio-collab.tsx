"use client";

import Link from "@/components/shell/demo-link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { AtSign, Bell, Bookmark, Check, Hash, MessageCircle, Pin, Search, Send, SmilePlus } from "@/components/ui/icons";
import clsx from "clsx";
import { useStudio } from "@/lib/studio-store";
import { personName, type Message, type Notice, type Task, ventureName } from "@/lib/studio-demo";
import { Badge, Empty, inputClass, PageFrame, PageTitle, Panel, PanelHead, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { useChatReady } from "@/components/studio/chat-ui";

const now = () => new Date().toISOString();
const dmId = (a: string, b: string) => `dm-${[a,b].sort().join("-")}`;

function Composer({ channelId, recipientId, parentId, onSent }: { channelId: string; recipientId?: string; parentId?: string; onSent?: () => void }) {
  const { data, currentUserId, updateSection } = useStudio();
  const [text,setText] = useState("");
  const [feedback,setFeedback] = useState("");
  const [preview,setPreview] = useState<{ kind:"assign"|"notify"; targetId:string; detail:string }|null>(null);
  const mention = text.match(/@([\w]*)$/)?.[1]?.toLowerCase();
  const suggestions = mention === undefined ? [] : data.people.filter((person) => person.id !== currentUserId && person.name.toLowerCase().includes(mention)).slice(0,4);
  const parse = () => {
    const match = text.trim().match(/^\/(assign|notify)\s+@([\w]+)\s+(.+)$/i);
    if (!match) { setFeedback("Use /assign @name task or /notify @name message."); return; }
    const person = data.people.find((candidate) => candidate.name.toLowerCase().startsWith(match[2].toLowerCase()));
    if (!person) { setFeedback("No matching team member. Pick a name from the mention list."); return; }
    setPreview({kind:match[1].toLowerCase() as "assign"|"notify",targetId:person.id,detail:match[3]}); setFeedback("");
  };
  const execute = () => {
    if (!preview) return;
    if (preview.kind === "notify") {
      const notice: Notice = {id:`notice-${Date.now()}`,title:`Message for ${personName(data,preview.targetId)}`,body:preview.detail,kind:"mention",at:now(),read:false};
      updateSection("notices",(items)=>[notice,...items]);
      setFeedback("Demo notification queued. Server delivery and permission checks are pending.");
    } else {
      const group = data.groups.find((item) => data.channels.some((channel) => channel.id === channelId && channel.groupId === item.id)) ?? data.groups[0];
      const task: Task = {id:`task-${Date.now()}`,ventureId:group.ventureId,groupId:group.id,title:preview.detail,outcome:preview.detail,ownerId:preview.targetId,reviewerId:currentUserId,priority:"P2",dueAt:"2026-09-30",reviewAt:"2026-09-30",effort:"To estimate",doneWhen:"Reviewer confirms evidence for the requested result",dependencies:"None recorded",evidence:"",status:"Backlog",blocker:"",accepted:false,tags:[],activity:[`Drafted from /assign by ${personName(data,currentUserId)}`]};
      updateSection("tasks",(items)=>[task,...items]);
      setFeedback("Draft task created. Complete its due date and evidence criteria in Tasks.");
    }
    setPreview(null);setText("");
  };
  const send = () => {
    const body=text.trim();if (!body)return;
    if (body.startsWith("/")) {parse();return;}
    const message: Message={id:`msg-${Date.now()}`,channelId,authorId:currentUserId,body,at:now(),parentId,reactions:[],pinned:false,saved:false};
    updateSection("messages",(items)=>[...items,message]);
    const mentioned = data.people.filter((person)=>body.toLowerCase().includes(`@${person.name.split(" ")[0].toLowerCase()}`) && person.id!==currentUserId);
    if (mentioned.length) updateSection("notices",(items)=>[...mentioned.map((person,index):Notice=>({id:`notice-${Date.now()}-${index}`,title:`${person.name} mentioned`,body:body.slice(0,120),kind:"mention",at:now(),read:false})),...items]);
    setText("");setFeedback("");onSent?.();
  };
  return <div className="border-t border-neutral-100 p-3"><div className="relative"><textarea aria-label={parentId?"Reply to thread":"Message composer"} value={text} onChange={(event)=>{setText(event.target.value);setPreview(null);}} onKeyDown={(event)=>{if(event.key==="Enter"&&!event.shiftKey){event.preventDefault();send();}}} placeholder={recipientId?"Message this person…":"Message channel… Use @mentions or /assign and /notify"} className={clsx(inputClass,"min-h-24 resize-y py-3 pr-12")} /><button type="button" aria-label="Send message" onClick={send} className="absolute bottom-3 right-3 grid h-9 w-9 place-items-center rounded-lg bg-primary-700 text-white hover:bg-primary-800"><Send size={15}/></button></div>
    {suggestions.length>0 && <div className="mt-2 flex flex-wrap gap-1" aria-label="Mention suggestions">{suggestions.map((person)=><button key={person.id} type="button" onClick={()=>setText((value)=>value.replace(/@[\w]*$/,`@${person.name.split(" ")[0]} `))} className="rounded-lg bg-primary-50 px-2 py-1 text-xs font-semibold text-primary-700">@{person.name.split(" ")[0]}</button>)}</div>}
    {preview && <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-primary-50 p-3 text-sm text-primary-900"><div><p className="font-extrabold">Preview /{preview.kind}</p><p>{personName(data,preview.targetId)} · {preview.detail}</p></div><div className="flex gap-2"><button onClick={()=>setPreview(null)} className={secondaryClass}>Cancel</button><button onClick={execute} className={primaryClass}>Confirm draft</button></div></div>}
    {feedback && <p role="status" className="mt-2 text-xs font-semibold text-neutral-500">{feedback}</p>}
    <p className="mt-2 text-xs text-neutral-400">Enter to send · Shift+Enter for a new line · Commands show a preview before creating demo records.</p>
  </div>;
}

function MessageRow({message,onThread}:{message:Message;onThread:(id:string)=>void}){
  const {data,updateSection}=useStudio();
  const author=data.people.find((person)=>person.id===message.authorId);
  const patch=(change:Partial<Message>)=>updateSection("messages",(items)=>items.map((item)=>item.id===message.id?{...item,...change}:item));
  const replies=data.messages.filter((item)=>item.parentId===message.id).length;
  return <article className="group flex gap-3 border-b border-neutral-100 px-4 py-4 hover:bg-neutral-50/70"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary-50 text-xs font-semibold text-primary-700">{author?.initials??"?"}</span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><strong className="text-sm text-neutral-800">{author?.name??"Unknown member"}</strong><time className="text-xs text-neutral-400">{new Date(message.at).toLocaleTimeString("en-IN",{hour:"numeric",minute:"2-digit"})}</time>{message.pinned&&<Badge tone="blue">Pinned</Badge>}</div><p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-neutral-700">{message.body}</p><div className="mt-2 flex flex-wrap gap-1"><button onClick={()=>patch({reactions:message.reactions.includes("👍 1")?message.reactions.filter((reaction)=>reaction!=="👍 1"):[...message.reactions,"👍 1"]})} aria-label="React thumbs up" className="rounded-lg border border-neutral-200 px-2 py-1 text-xs text-neutral-500 hover:bg-white"><SmilePlus size={12} className="inline" /> {message.reactions.join(" ")||"React"}</button><button onClick={()=>onThread(message.id)} className="rounded-lg px-2 py-1 text-xs font-semibold text-neutral-500 hover:bg-white"><MessageCircle size={12} className="inline" /> Thread {replies||""}</button><button onClick={()=>patch({saved:!message.saved})} className="rounded-lg px-2 py-1 text-xs font-semibold text-neutral-500 hover:bg-white"><Bookmark size={12} className="inline" />{message.saved?"Saved":"Save"}</button><button onClick={()=>patch({pinned:!message.pinned})} className="rounded-lg px-2 py-1 text-xs font-semibold text-neutral-500 hover:bg-white"><Pin size={12} className="inline" />{message.pinned?"Unpin":"Pin"}</button></div></div></article>;
}

export function ChannelsScreen(){
  useChatReady(true);
  const {data}=useStudio();const params=useSearchParams();const initial=params.get("channel")??data.channels.find((item)=>item.unread>0)?.id??data.channels[0]?.id;const [channelId,setChannelId]=useState(initial);const [query,setQuery]=useState("");const [thread,setThread]=useState<string|null>(null);const [view,setView]=useState<"messages"|"pins"|"saved">("messages");
  useEffect(()=>{const id=params.get("channel");if(id&&data.channels.some((item)=>item.id===id))queueMicrotask(()=>{setChannelId(id);setThread(null);});},[params,data.channels]);
  const channel=data.channels.find((item)=>item.id===channelId)??data.channels[0];const group=data.groups.find((item)=>item.id===channel.groupId);const rootMessages=data.messages.filter((item)=>item.channelId===channel.id&&!item.parentId&&(view==="messages"||(view==="pins"?item.pinned:item.saved))&&item.body.toLowerCase().includes(query.toLowerCase()));
  return <PageFrame><PageTitle title="Channels" description="Venture → group → channel. Conversations stay in the work context that owns them." action={<Link href="/channels/live" className={secondaryClass}>Workspace channels</Link>} />
    <div className="grid gap-4 lg:grid-cols-[230px_minmax(0,1fr)]"><Panel className="max-h-48 overflow-y-auto p-3 lg:max-h-none lg:overflow-visible"><p className="px-2 pb-2 text-xs font-semibold uppercase tracking-[.08em] text-neutral-400">Venture channels</p>{data.ventures.map((venture)=><div key={venture.id} className="mb-3"><p className="px-2 py-2 text-xs font-semibold text-neutral-800">{venture.name}</p>{data.groups.filter((item)=>item.ventureId===venture.id).map((item)=><div key={item.id}><p className="px-3 py-1 text-xs font-semibold text-neutral-400">{item.name}</p>{data.channels.filter((child)=>child.groupId===item.id).map((child)=><button key={child.id} onClick={()=>{setChannelId(child.id);setThread(null);}} className={clsx("flex min-h-9 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-semibold",channel.id===child.id?"bg-primary-50 text-primary-700":"text-neutral-500 hover:bg-neutral-50")}><Hash size={14}/><span className="flex-1">{child.name}</span>{child.unread>0&&<Badge tone="blue">{child.unread}</Badge>}</button>)}</div>)}</div>)}</Panel>
      <Panel className="flex min-h-[640px] flex-col overflow-hidden"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-100 px-4 py-3"><div><h2 className="flex items-center gap-2 text-base font-bold text-neutral-900"><Hash size={17}/>{channel.name}</h2><p className="mt-1 text-xs text-neutral-500">{ventureName(data,group?.ventureId??"")} · {group?.name} · {group?.memberIds.length??0} members</p></div><div className="flex items-center gap-2"><Search size={15} className="text-neutral-400"/><input aria-label="Search channel" value={query} onChange={(event)=>setQuery(event.target.value)} placeholder="Search channel" className="w-32 rounded-lg border border-neutral-200 px-2 py-1.5 text-xs outline-none focus:border-primary-400 sm:w-44"/></div></div><div className="flex gap-1 border-b border-neutral-100 px-3 py-2">{(["messages","pins","saved"] as const).map((item)=><button key={item} onClick={()=>setView(item)} className={clsx("rounded-lg px-3 py-1.5 text-xs font-semibold capitalize",view===item?"bg-primary-700 text-white":"text-neutral-500 hover:bg-neutral-50")}>{item}</button>)}</div><div className="thin-scroll min-h-72 flex-1 overflow-y-auto">{rootMessages.length?rootMessages.map((message)=><MessageRow key={message.id} message={message} onThread={setThread}/>):<Empty title="No messages in this view" body="Try another tab, search, or start the conversation."/>}</div><Composer channelId={channel.id}/></Panel>
    </div>{thread&&<div className="fixed inset-0 z-50 flex justify-end bg-neutral-900/25" onMouseDown={(event)=>event.target===event.currentTarget&&setThread(null)}><aside role="dialog" aria-modal="true" aria-label="Message thread" className="vso-enter-right flex h-full w-full max-w-[520px] flex-col bg-white shadow-e4"><div className="flex items-center justify-between border-b border-neutral-100 p-4"><h2 className="text-base font-bold text-neutral-900">Thread</h2><button onClick={()=>setThread(null)} className={secondaryClass}>Close</button></div><div className="thin-scroll flex-1 overflow-y-auto">{data.messages.filter((item)=>item.id===thread||item.parentId===thread).map((item)=><MessageRow key={item.id} message={item} onThread={setThread}/>)}</div><Composer channelId={channel.id} parentId={thread}/></aside></div>}
  </PageFrame>;
}

export function MessagesScreen(){
  useChatReady(true);
  const {data,currentUserId}=useStudio();const [personId,setPersonId]=useState(data.people.find((person)=>person.id!==currentUserId)?.id??"");const channelId=dmId(currentUserId,personId);const rows=data.messages.filter((item)=>item.channelId===channelId&&!item.parentId);return <PageFrame><PageTitle title="Direct messages" description="Workspace-wide conversations with the people you work with."/><div className="grid gap-4 lg:grid-cols-[230px_minmax(0,1fr)]"><Panel className="p-3"><p className="px-2 pb-2 text-xs font-semibold uppercase text-neutral-400">People</p>{data.people.filter((person)=>person.id!==currentUserId).map((person)=><button key={person.id} onClick={()=>setPersonId(person.id)} className={clsx("flex min-h-12 w-full items-center gap-2 rounded-xl px-2 text-left",personId===person.id?"bg-primary-50":"hover:bg-neutral-50")}><span className="grid h-8 w-8 place-items-center rounded-full bg-primary-100 text-xs font-semibold text-primary-700">{person.initials}</span><span><span className="block text-sm font-semibold text-neutral-800">{person.name}</span><span className="block text-xs text-neutral-400">{person.role}</span></span></button>)}</Panel><Panel className="flex min-h-[620px] flex-col overflow-hidden"><PanelHead title={personName(data,personId)}/><div className="thin-scroll flex-1 overflow-y-auto">{rows.length?rows.map((item)=><MessageRow key={item.id} message={item} onThread={()=>{}}/>):<Empty title="Start a conversation" body="Messages are visible only to participants in this demo view."/>}</div><Composer channelId={channelId} recipientId={personId}/></Panel></div></PageFrame>}

export function NotificationsScreen(){const {data,updateSection}=useStudio();const [filter,setFilter]=useState<"All"|"Unread">("All");const rows=data.notices.filter((item)=>filter==="All"||!item.read);const patch=(id:string,change:Partial<Notice>)=>updateSection("notices",(items)=>items.map((item)=>item.id===id?{...item,...change}:item));return <PageFrame><PageTitle title="Notifications" description="Mentions, reviews, assignments, and reminders in one place." action={<button onClick={()=>updateSection("notices",(items)=>items.map((item)=>({...item,read:true})))} className={secondaryClass}><Check size={15}/>Mark all read</button>}/><Panel><div className="flex gap-2 border-b border-neutral-100 p-3">{(["All","Unread"] as const).map((item)=><button key={item} onClick={()=>setFilter(item)} className={clsx("min-h-9 rounded-lg px-3 text-sm font-semibold",filter===item?"bg-primary-700 text-white":"text-neutral-500 hover:bg-neutral-50")}>{item}</button>)}</div>{rows.length?rows.map((notice)=><div key={notice.id} className={clsx("flex flex-wrap items-start gap-3 border-b border-neutral-100 p-4",!notice.read&&"bg-primary-50/40")}><span className="grid h-9 w-9 place-items-center rounded-xl bg-primary-50 text-primary-700">{notice.kind==="mention"?<AtSign size={17}/>:<Bell size={17}/>}</span><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><p className="text-sm font-semibold text-neutral-800">{notice.title}</p>{!notice.read&&<span className="h-2 w-2 rounded-full bg-primary-600"/>}</div><p className="mt-1 text-sm text-neutral-500">{notice.body}</p><p className="mt-1 text-xs text-neutral-400">{new Date(notice.at).toLocaleString("en-IN")}{notice.snoozedUntil?` · Snoozed until ${new Date(notice.snoozedUntil).toLocaleTimeString("en-IN")}`:""}</p></div><div className="flex flex-wrap gap-1">{notice.taskId&&<Link href={`/tasks?task=${notice.taskId}`} onClick={()=>patch(notice.id,{read:true})} className="rounded-lg px-2 py-1.5 text-xs font-semibold text-primary-700 hover:bg-primary-50">Open task</Link>}<button onClick={()=>patch(notice.id,{read:!notice.read})} className="rounded-lg px-2 py-1.5 text-xs font-semibold text-neutral-600 hover:bg-neutral-100">{notice.read?"Mark unread":"Mark read"}</button><button onClick={()=>patch(notice.id,{snoozedUntil:new Date(Date.now()+60*60*1000).toISOString()})} className="rounded-lg px-2 py-1.5 text-xs font-semibold text-neutral-600 hover:bg-neutral-100">Snooze 1h</button></div></div>):<Empty title="Inbox clear" body="There are no notifications in this view."/>}</Panel></PageFrame>}
