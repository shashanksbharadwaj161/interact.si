import type {RoutinesView,UndoOutcome} from '../../electron/services/routines';
import type {RoutinePlan} from '../../electron/services/intent';
import type {ModelsOverview,PackValidation,ResourceProfileId,Result as ModelResult} from '../../electron/services/models';
import type {IntegrationView,EgressPreview,CheckResult,UsageEntry} from '../ui/integration-catalog';
import type {UsageReport,Price,Budget} from '../../electron/services/usage';
import type {ClipboardStatus,ClipboardEntryView} from '../../electron/services/clipboard';
import type {ResourceSnapshot} from '../../electron/services/system';
import type {ProductivityState,ProductivityOp,ForgetHistoryOptions} from '../../electron/services/store';
import type {RestorePreview,PathRoot,PathMapping,PackImport} from '../../electron/services/capsules';
import type {ExternalDoc} from '../../electron/services/search';
import type {CalendarEvent,IcsParseResult} from '../../electron/services/calendar';
import type {OcrResult,OcrStatus} from '../../electron/services/ocr';
export type {OcrResult,OcrStatus};
export type Mode='offline'|'online';
export type Capability={id:string;name:string;available:boolean;reason?:string};
/** Optional cloud chat providers. Each is reached only in online mode, only with that provider's own stored key. */
export type CloudProvider='anthropic'|'openai'|'openrouter';
/** host is a display name for the single origin the network guard allows for that provider's chat endpoint. */
export type CloudProviderInfo={id:CloudProvider;name:string;host:string;defaultModel:string;capability:string};
export const CLOUD_PROVIDERS:readonly CloudProviderInfo[]=[
 {id:'anthropic',name:'Anthropic',host:'api.anthropic.com',defaultModel:'claude-haiku-4-5',capability:'Claude models through the Messages API; streamed text replies.'},
 {id:'openai',name:'OpenAI',host:'api.openai.com',defaultModel:'gpt-4o-mini',capability:'GPT models through the Chat Completions API; streamed text replies.'},
 {id:'openrouter',name:'OpenRouter',host:'openrouter.ai',defaultModel:'openai/gpt-4o-mini',capability:'Many vendors behind one key (model ids look like vendor/model); streamed text replies.'},
];
export const DEFAULT_CLOUD_PROVIDER:CloudProvider='anthropic';
export const isCloudProvider=(v:unknown):v is CloudProvider=>typeof v==='string'&&CLOUD_PROVIDERS.some((p)=>p.id===v);
export const cloudProviderInfo=(p:unknown):CloudProviderInfo=>CLOUD_PROVIDERS.find((x)=>x.id===p)??CLOUD_PROVIDERS[0];
/**
 * The model id actually sent to a provider: the configured cloudModel unless it is empty or clearly belongs to another
 * provider family (claude-* is Anthropic, vendor/model is OpenRouter, gpt-/o1/o3/o4/chatgpt- is OpenAI); then the provider default.
 */
export function effectiveCloudModel(provider:unknown,cloudModel:unknown):string{
 const info=cloudProviderInfo(provider);
 const m=typeof cloudModel==='string'?cloudModel.trim():'';
 if(!m)return info.defaultModel;
 const slash=m.includes('/'),claude=/^claude/i.test(m),gpt=/^(gpt-|chatgpt-|o[134](-|$))/i.test(m);
 if(info.id==='anthropic')return slash||gpt?info.defaultModel:m;
 if(info.id==='openai')return slash||claude?info.defaultModel:m;
 return slash?m:info.defaultModel;
}
/** Per-provider key status for the renderer. Never carries a key. keyChannel says how keys are stored for this provider in this build. */
export type CloudProviderStatus={provider:CloudProvider;name:string;hasKey:boolean|null;origin:string;defaultModel:string;keyChannel?:'per-provider'|'legacy'|'unavailable';reason?:string};
/** One model a provider reports as available to the saved key. Ids come from the provider, never from this app. */
export type CloudModelInfo={id:string;name:string;createdAt?:string};
/** Result of asking a provider which models the saved key can use. available=false always carries a reason. */
export type CloudModelList={provider:CloudProvider;available:boolean;models:CloudModelInfo[];reason?:string;checkedAt:string};
/** Per-provider key methods are required in the full host; partial preview clients may omit them. */
export type CloudProviderMethod='cloudProviderStatus'|'setProviderKey'|'clearProviderKey';
export type Settings={onboarded:boolean;mode:Mode;theme:'graphite'|'nebula'|'paper';reduceMotion:boolean;startInTray:boolean;localModel:string;localEndpoint:string;cloudModel:string;/** Always present in state parsed by the backend (defaults to 'anthropic'); optional only so older literal Settings still type-check. */cloudProvider?:CloudProvider;voice:string;/** The microphone policy, enforced by the main process: off until the person allows it in a trusted confirmation; the session refuses audio while it is off. Optional only so older literal Settings still type-check. */voiceInput?:boolean;allowedRoots:string[];approvedApps:string[];retainDays:number};
export type Capsule={id:string;name:string;description:string;scene:string;createdAt:string;updatedAt:string;items:{kind:'file'|'folder'|'url'|'app';target:string;label:string}[];windows?:{title:string;process:string;x:number;y:number;width:number;height:number}[]};
export type Note={id:string;title:string;body:string;tags:string[];updatedAt:string};
export type Task={id:string;title:string;done:boolean;due?:string;createdAt:string};
export type ChatMessage={id:string;role:'user'|'assistant';text:string;createdAt:string;source:'local'|'cloud'|'system'};
export type Activity={id:string;at:string;kind:string;summary:string;details?:string};
export type AppState={settings:Settings;capsules:Capsule[];notes:Note[];tasks:Task[];chat:ChatMessage[];activity:Activity[]};
export type SystemInfo={platform:string;arch:string;ramGB:number;cpu:string;capabilities:Capability[]};
/** Where a battery/power reading came from. 'unmeasured' means nobody could read it; nothing is estimated. */
export type BatterySource='host'|'navigator'|'unmeasured';
/** Host power state (Electron powerMonitor). onBattery is null when unmeasured. The host never reports a percentage. */
export type HostBatteryStatus={source:BatterySource;onBattery:boolean|null;measuredAt:string};
export type ActionRequest={type:'launch'|'focus'|'move-window'|'type-text'|'click'|'open-url'|'list-windows';target?:string;text?:string;x?:number;y?:number;width?:number;height?:number};
export type ActionPreview={id:string;summary:string;requiresApproval:boolean;allowed:boolean;reason?:string};
/**
 * open-path / reveal-folder (additive): target is the exact absolute local path. Same previewAction/executeAction
 * preview-id + approval flow as ActionRequest. Kept as a separate member so existing Record<ActionRequest['type'],…> maps stay exhaustive.
 */
export type PathActionType='open-path'|'reveal-folder';
export type PathActionRequest={type:PathActionType;target:string};
export type AnyActionRequest=ActionRequest|PathActionRequest;
// API v2 additions (backwards compatible: every new JarvisAPI method is optional, so older bridges still type-check).
/** Offline intent plan. 'ready' is only a preview candidate: it never authorizes or runs anything. */
export type IntentField='target'|'text'|'x'|'y'|'width'|'height'|'url'|'command';
export type IntentSource='rules'|'model';
export type IntentCandidate={label:string;request:ActionRequest};
export type IntentPlan=
 |{status:'ready';source:IntentSource;request:ActionRequest;summary:string;previewOnly:true}
 |{status:'clarify';source:IntentSource;summary:string;question:string;missing:IntentField[];candidates?:IntentCandidate[]}
 |{status:'blocked';source:IntentSource;summary:string;reason:string};
/** useLocalModel: when the rule planner does not recognize the command, ask the local (loopback) model for a JSON plan. Never the cloud. */
export type IntentOptions={useLocalModel?:boolean};
export type SearchCategory='note'|'task'|'capsule'|'chat';
export type SearchResult={category:SearchCategory;id:string;title:string;snippet:string;relevance:number};
export type SearchOptions={includeChat?:boolean;limit?:number};
export type LocalModel={name:string;sizeBytes?:number;modifiedAt?:string;family?:string;parameterSize?:string;quantization?:string};
export type LocalModelList={available:boolean;endpoint:string;models:LocalModel[];reason?:string};
export type ApiFeatureId='intent-planner'|'intent-model-assist'|'search'|'local-models'|'chat-streaming'|'chat-cancel'|'routines'|'region-capture'|'ocr'|'vision'|'automatic-input'|'integrations'|'model-runtime'|'usage-ledger'|'clipboard-history'|'resource-monitor'|'productivity'|'capsule-packs'|'calendar'|'approved-documents';
export type ApiFeature={id:ApiFeatureId;available:boolean;reason?:string};
export type ApiInfo={apiVersion:number;features:ApiFeature[]};
/** Streaming chat (v2.3). One generation at a time; streamId is an unguessable capability returned only to the caller that started it. */
export type ChatStreamRoute='local'|'cloud';
export type ChatStreamStart={streamId:string;generation:number;route:ChatStreamRoute};
/** complete: full reply stored. truncated: the app stopped reading at its reply-length cap (the model may have had more); stored with a note. cancelled: stopped by you (or offline switch); partial text, if any, stored once and marked incomplete. incomplete: the connection ended early. failed: nothing generated. */
export type ChatStreamOutcome='complete'|'truncated'|'cancelled'|'incomplete'|'failed';
type StreamTag={streamId:string;generation:number;seq:number};
export type ChatStreamEvent=
 |(StreamTag&{type:'status';status:'connecting'|'streaming'})
 |(StreamTag&{type:'delta';text:string})
 |(StreamTag&{type:'done';outcome:ChatStreamOutcome;reply:ChatMessage;stored:ChatMessage[]})
 /** Produced by the preload subscription itself when the main process stops answering; the stored chat is the source of truth. */
 |(StreamTag&{type:'lost';reason:string});
/** One long-poll batch. next is the cursor to pass to the following read; ended means no further events will come. */
export type ChatStreamBatch={events:ChatStreamEvent[];next:number;ended:boolean};
export interface JarvisAPI {
 getState():Promise<AppState>;saveSettings(settings:Partial<Settings>):Promise<AppState>;getSystemInfo():Promise<SystemInfo>;
 saveCapsule(capsule:Partial<Capsule>):Promise<AppState>;deleteCapsule(id:string):Promise<AppState>;restoreCapsule(id:string):Promise<{opened:string[];failed:{target:string;reason:string}[]}>;
 saveNote(note:Partial<Note>):Promise<AppState>;deleteNote(id:string):Promise<AppState>;saveTask(task:Partial<Task>):Promise<AppState>;deleteTask(id:string):Promise<AppState>;
 chat(text:string):Promise<ChatMessage>;clearChat():Promise<AppState>;setCloudKey(key:string):Promise<{configured:boolean}>;cloudKeyStatus():Promise<{configured:boolean}>;deleteCloudKey():Promise<void>;
 previewAction(action:AnyActionRequest):Promise<ActionPreview>;executeAction(previewId:string,approved:boolean):Promise<unknown>;
 speak(text:string):Promise<{ok:boolean;reason?:string}>;transcribe(audio:number[]):Promise<{text:string;reason?:string;cancelled?:boolean}>;
 /** v2.5 voice controls, optional. speechStop ends this app's read-aloud (true when something was playing). transcribeCancel makes a transcription in flight return no text; the Windows helper may still finish its own work, and the pending transcribe() call settles when it does. */
 speechStop?():Promise<boolean>;transcribeCancel?():Promise<boolean>;
 exportData():Promise<{path:string|null}>;importData():Promise<AppState>;pickPath(kind:'file'|'folder'):Promise<string|null>;onActivity(handler:(activity:Activity)=>void):()=>void;
 /** v2, optional. Absent in the browser preview bridge; callers must check before use. */
 getApiInfo?():Promise<ApiInfo>;
 /** Per-provider cloud keys (goal 102), optional. Provider ids are validated before any secret is touched; keys are never returned. */
 cloudProviderStatus?():Promise<CloudProviderStatus[]>;setProviderKey?(provider:CloudProvider,key:string):Promise<{provider:CloudProvider;configured:boolean}>;clearProviderKey?(provider:CloudProvider):Promise<{provider:CloudProvider;configured:boolean}>;
 /** Models the saved key for this provider can use (GET /v1/models through the network guard). Online mode only; the key never leaves the main process. */
 cloudModels?(provider:CloudProvider):Promise<CloudModelList>;
 planIntent?(command:string,options?:IntentOptions):Promise<IntentPlan>;
 search?(query:string,options?:SearchOptions):Promise<SearchResult[]>;
 listLocalModels?():Promise<LocalModelList>;
 /** v2.3 streaming chat, optional. chat() above is unchanged. onChatStream is implemented by the preload over chatStreamRead and delivers only this stream's events, in order. */
 chatStreamStart?(text:string):Promise<ChatStreamStart>;chatStreamRead?(streamId:string,cursor:number):Promise<ChatStreamBatch>;chatStreamCancel?(streamId:string):Promise<boolean>;
 onChatStream?(start:ChatStreamStart,handler:(event:ChatStreamEvent)=>void):()=>void;
 /** v2.1 captain integration, optional. Flat validated IPC methods; src/ui/bridges.ts adapts them to the module client shapes. */
 routinesList?():Promise<RoutinesView>;routinesSave?(draft:unknown):Promise<RoutinesView>;routinesRemove?(id:string):Promise<RoutinesView>;routinesStart?(id:string):Promise<{runId:string}>;routinesCancel?(runId:string):Promise<RoutinesView>;routinesPauseAll?():Promise<RoutinesView>;routinesResumeAll?():Promise<RoutinesView>;routinesUndo?(runId:string):Promise<UndoOutcome>;routinesPlanText?(text:string):Promise<RoutinePlan>;routinesPlanModel?(json:string):Promise<RoutinePlan>;
 modelsOverview?():Promise<ModelsOverview>;modelsSelect?(name:string,opts?:{warm?:boolean;unloadOthers?:boolean}):Promise<ModelResult<{patch:{localModel:string};warmed:boolean}>>;modelsUnload?(name?:string):Promise<ModelResult<{unloaded:string[]}>>;modelsSetProfile?(id:ResourceProfileId):Promise<ResourceProfileId>;modelsValidatePack?(dir:string):Promise<PackValidation>;modelsStartImport?(dir:string,name?:string):Promise<ModelResult<{jobId:string}>>;modelsStartPull?(model:string):Promise<ModelResult<{jobId:string}>>;modelsCancelJob?(id:string):Promise<boolean>;modelsPickPackFolder?():Promise<string|null>;
 integrationsList?():Promise<IntegrationView[]>;integrationsPreview?(id:string):Promise<EgressPreview>;integrationsCheck?(id:string):Promise<CheckResult>;integrationsSetKey?(id:string,key:string):Promise<{configured:boolean;warning?:string}>;integrationsRemoveKey?(id:string):Promise<{configured:boolean}>;integrationsSetEnabled?(id:string,enabled:boolean):Promise<IntegrationView>;integrationsUsage?():Promise<UsageEntry[]>;integrationsClearUsage?():Promise<void>;
 usageReport?():Promise<UsageSummary>;usageExport?(format:'csv'|'json'):Promise<{path:string|null;rows:number;truncated:boolean}>;usageSetPrices?(input:{prices:unknown}):Promise<Price[]>;usageSetBudget?(input:{budget:unknown}):Promise<Budget|null>;
 clipboardStatus?():Promise<ClipboardStatus>;clipboardSetEnabled?(on:boolean):Promise<ClipboardStatus>;clipboardList?():Promise<ClipboardEntryView[]>;clipboardGet?(id:string):Promise<string|null>;clipboardRemove?(id:string):Promise<boolean>;clipboardPurge?():Promise<ClipboardStatus>;
 systemResources?():Promise<ResourceSnapshot>;
 /** v2.2 data API, optional. Productivity sidecar, capsule restore preview/packs, history forgetting and local .ics calendar. */
 productivityGet?():Promise<ProductivityState>;productivityApply?(op:ProductivityOp):Promise<ProductivityState>;productivityForgetHistory?(opts:ForgetHistoryOptions):Promise<{removed:{chat:number;activity:number}}>;productivitySignals?():Promise<ExternalDoc[]>;
 capsulePreviewRestore?(id:string):Promise<RestorePreview>;capsuleListWindows?():Promise<CapsuleWindowChoice[]>;capsuleCaptureGeometry?(id:string,hwnds:number[]):Promise<CapsuleCaptureResult>;capsuleExportPack?(id:string,roots:PathRoot[]):Promise<{saved:boolean;unmapped:string[]}>;capsuleReadPack?():Promise<string|null>;capsuleParsePack?(raw:string,mappings:PathMapping[]):Promise<PackImport>;
 calendarList?():Promise<CalendarEvent[]>;calendarImportText?(text:string):Promise<CalendarImportSummary>;calendarImportFile?():Promise<CalendarImportSummary&{imported:boolean}>;calendarExport?():Promise<{saved:boolean;events:number}>;calendarClear?():Promise<{removed:number}>;
 /** One dialog-selected local image. Paths never cross IPC; recognized text is untrusted review data. */
 ocrStatus?():Promise<OcrStatus>;ocrRecognize?(options?:{language?:string}):Promise<OcrResult>;ocrCancel?():Promise<boolean>;
 /** v2.4 approved documents, optional. One dialog-chosen .txt/.md file: bounded strict-UTF-8 plain-text preview behind an opaque token. Paths never cross IPC; nothing is stored until documentsSave after review. */
 documentsChoose?():Promise<ApprovedDocumentPreview>;documentsSave?(token:string,options?:ApprovedDocumentSaveOptions):Promise<{saved:true;title:string}>;documentsDiscard?(token:string):Promise<boolean>;
 /** Nested productivity namespace read by src/ui/store.tsx. Built from the flat methods by productivityBridge (src/ui/bridges.ts). */
 productivity?:ProductivityNamespace;
}
/** Untrusted plain text from a user-chosen file: render as text only, never as HTML/Markdown markup or as an action. name is the file name only. */
export type ApprovedDocumentPreview=
 |{status:'cancelled'}
 |{status:'unsupported';name:string;format:string;reason:string}
 |{status:'ready';token:string;name:string;format:'text'|'markdown';bytes:number;chars:number;lines:number;text:string;suggestedTitle:string};
export type ApprovedDocumentSaveOptions={title?:string;tags?:string[]};
export type CapsuleWindowChoice={hwnd:number;title:string;process:string};
export type CapsuleCaptureResult={saved:number;skipped:{process:string;reason:string}[]};
/** Counts only: no file path is ever returned to the renderer. */
export type CalendarImportSummary={added:number;dropped:number;total:number;skipped:IcsParseResult['skipped'];error?:NonNullable<IcsParseResult['error']>};
/** Structurally identical to src/ui/store.tsx ProductivityAPI. Every member that needs main-process data is a validated IPC call. */
export type ProductivityNamespace={
 get():Promise<ProductivityState>;apply(op:ProductivityOp):Promise<ProductivityState>;
 forgetHistory(opts:ForgetHistoryOptions):Promise<{removed:{chat:number;activity:number}}>;
 capsule:{previewRestore(id:string):Promise<RestorePreview>;listWindows():Promise<CapsuleWindowChoice[]>;captureGeometry(id:string,hwnds:number[]):Promise<CapsuleCaptureResult>;exportPack(id:string,roots:PathRoot[]):Promise<{saved:boolean;unmapped:string[]}>;readPack():Promise<string|null>;parsePack(raw:string,mappings:PathMapping[]):Promise<PackImport>};
 signals():Promise<ExternalDoc[]>;
};
export type UsagePerformanceRow={tokensPerSecond:number|null;eventId:string;at:string;model:string;outputTokens:number};
export type UsageSummary={report:UsageReport;performance:UsagePerformanceRow[]};
/** The Electron preload implements every method. */
export type FullJarvisAPI=Required<JarvisAPI>;
/**
 * Read-only host power state (on battery or on AC) from Electron powerMonitor; no percentage. Exposed by the preload as
 * window.jarvisHost, separate from the backend METHOD table: main pushes the state to the trusted page and the preload keeps
 * the latest value. hostBattery() returns it (unmeasured until the first push); onHostBattery delivers changes and returns an unsubscribe.
 */
export interface HostBatteryAPI{hostBattery?():Promise<HostBatteryStatus>;onHostBattery?(handler:(status:HostBatteryStatus)=>void):()=>void}
declare global{interface Window{jarvis:JarvisAPI;jarvisHost?:HostBatteryAPI}}
