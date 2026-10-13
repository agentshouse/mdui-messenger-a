import {vi} from 'vitest';
import type {Runtime} from '../src/data/house';
export const ID='11111111-1111-4111-8111-111111111111';
export const MESSAGE='22222222-2222-4222-8222-222222222222';
export const NOW='2026-10-10T09:00:00Z';
export const chat=(room='r_one')=>({room,path:'chats/main.md',type:'messenger_chat',fields:{id:ID,title:'Design review',mode:'direct',created_at:NOW}});
export const message=(room='r_one')=>({room,path:`messages/${MESSAGE}.md`,type:'messenger_message',fields:{id:MESSAGE,chat:'../chats/main.md',text:'Ready for review',kind:'text',attachments:[],created_at:NOW},change:{author:{kind:'user',id:'u_alex',name:'Alex'}}});
export function observation<T>(value:T){let current=value;const listeners=new Set<()=>void>();return {current:()=>current,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>listeners.delete(listener);},close:vi.fn(),publish:(next:T)=>{current=next;listeners.forEach(fn=>fn());}};}
type FakeDraft={room:string;path:string;revision:string;parts:Record<string,unknown>;returned:null;changedUnderneath:Record<string,never>};
export function fakeRuntime(initial:unknown[]=[chat(),message()]) {
 let docs=initial; const drafts=new Map<string,FakeDraft>(); let revision=0;
 const rooms=observation([{locator:'r_one',name:'Design review'},{locator:'r_two',name:'Team'}]);
 const draftWatch=observation<FakeDraft[]>([]);
 const observations={'room-drafts':draftWatch,query:observation({documents:docs}),rooms,'sync-status':observation({lastCompleted:NOW as string|null,attentionRequired:[],providerUnreachable:false,state:'synced'}),'service-mode':observation('open'),'connection-refusal':observation<unknown>(null),'storage-loss':observation<unknown>(null)};
 const binaries=new Map<string,Blob>();
 const raw={binaryFile:{read:vi.fn(async(_room:string,path:string)=>binaries.has(path)?{kind:'binary',blob:binaries.get(path)}:{kind:'absent',code:'not_found',retryable:false})},rooms:vi.fn(async()=>rooms.current()),query:vi.fn(async()=>({documents:docs})),observe:vi.fn(async(topic:keyof typeof observations)=>observations[topic]),roomDraft:{list:vi.fn(async()=>[...drafts.values()]),read:vi.fn(async(_room:string,path:string)=>drafts.get(path)??null),write:vi.fn(async(room:string,path:string,base:unknown,parts:Record<string,unknown>)=>{const prior=drafts.get(path);if((prior?.revision??null)!==base)return {outcome:'stale',current:prior??null};const draft={room,path,revision:`draft-${++revision}`,parts,returned:null,changedUnderneath:{}};drafts.set(path,draft);draftWatch.publish([...drafts.values()]);return {outcome:'written',roomDraft:draft};})},save:vi.fn(async(room:string,entries:{path:string;revision:string}[])=>{for(const entry of entries){const parts=drafts.get(entry.path)!.parts; if(parts.file){binaries.set(entry.path,(parts.file as {blob:Blob}).blob);drafts.delete(entry.path);continue;}const value=parts.creation as {type:string;fields:unknown};docs=[...docs,{room,path:entry.path,type:value.type,fields:value.fields,change:{author:{kind:'user',id:'u_member',name:'Room member'}}}];drafts.delete(entry.path);}draftWatch.publish([...drafts.values()]);observations.query.publish({documents:docs});return {outcome:'saved',identifier:'save-1'};}),call:vi.fn(async()=>({kind:'action',result:null}))};
 return {runtime:raw as unknown as Runtime,raw,observations,drafts,setDocuments:(next:unknown[])=>{docs=next;observations.query.publish({documents:docs});}};
}
