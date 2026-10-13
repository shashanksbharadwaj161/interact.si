export type Mode='offline'|'online';
export type Capability={id:string;name:string;available:boolean;reason?:string};
export type Settings={onboarded:boolean;mode:Mode;theme:'graphite'|'nebula'|'paper';reduceMotion:boolean;startInTray:boolean;localModel:string;localEndpoint:string;cloudModel:string;voice:string;allowedRoots:string[];approvedApps:string[];retainDays:number};
export type Capsule={id:string;name:string;description:string;scene:string;createdAt:string;updatedAt:string;items:{kind:'file'|'folder'|'url'|'app';target:string;label:string}[];windows?:{title:string;process:string;x:number;y:number;width:number;height:number}[]};
export type Note={id:string;title:string;body:string;tags:string[];updatedAt:string};
export type Task={id:string;title:string;done:boolean;due?:string;createdAt:string};
export type ChatMessage={id:string;role:'user'|'assistant';text:string;createdAt:string;source:'local'|'cloud'|'system'};
export type Activity={id:string;at:string;kind:string;summary:string;details?:string};
export type AppState={settings:Settings;capsules:Capsule[];notes:Note[];tasks:Task[];chat:ChatMessage[];activity:Activity[]};
export type SystemInfo={platform:string;arch:string;ramGB:number;cpu:string;capabilities:Capability[]};
export type ActionRequest={type:'launch'|'focus'|'move-window'|'type-text'|'click'|'open-url'|'list-windows';target?:string;text?:string;x?:number;y?:number;width?:number;height?:number};
export type ActionPreview={id:string;summary:string;requiresApproval:boolean;allowed:boolean;reason?:string};
export interface JarvisAPI {
 getState():Promise<AppState>;saveSettings(settings:Partial<Settings>):Promise<AppState>;getSystemInfo():Promise<SystemInfo>;
 saveCapsule(capsule:Partial<Capsule>):Promise<AppState>;deleteCapsule(id:string):Promise<AppState>;restoreCapsule(id:string):Promise<{opened:string[];failed:{target:string;reason:string}[]}>;
 saveNote(note:Partial<Note>):Promise<AppState>;deleteNote(id:string):Promise<AppState>;saveTask(task:Partial<Task>):Promise<AppState>;deleteTask(id:string):Promise<AppState>;
 chat(text:string):Promise<ChatMessage>;clearChat():Promise<AppState>;setCloudKey(key:string):Promise<{configured:boolean}>;cloudKeyStatus():Promise<{configured:boolean}>;deleteCloudKey():Promise<void>;
 previewAction(action:ActionRequest):Promise<ActionPreview>;executeAction(previewId:string,approved:boolean):Promise<unknown>;
 speak(text:string):Promise<{ok:boolean;reason?:string}>;transcribe(audio:number[]):Promise<{text:string;reason?:string}>;
 exportData():Promise<{path:string|null}>;importData():Promise<AppState>;pickPath(kind:'file'|'folder'):Promise<string|null>;onActivity(handler:(activity:Activity)=>void):()=>void;
}
declare global{interface Window{jarvis:JarvisAPI}}
