// Idle or exited alone does not prove that a worker finished its work. Budget
// denials, context limits and worker errors also leave the session idle, so
// the room classifies the stop reason before it offers results for review.

// Patterns are matched only against explicit error text (session error fields
// and recent task events), never against worker conversation content.
const BUDGET=/spending reservation denied|task budget|budget (?:exhausted|reached|exceeded)|budget would be exceeded|no verified spending policy|further requests blocked/i;
const CONTEXT=/context (?:window|limit|length)|context exceeds development limit|prompt is too long|maximum context|too many tokens|input is too long/i;
const PROVIDER_ACCESS=/credit balance.*too low|insufficient (?:credit|balance)|Provider HTTP (?:401|403)/i;
const ERROR=/\b(?:error|failed|failure|exception|timed? ?out|rate limit|HTTP [45]\d\d|overloaded)\b/i;
const TRANSIENT=/fetch failed|network (?:error|failure)|connection (?:reset|refused)|ECONNRESET|ECONNREFUSED|timed? ?out|rate limit|HTTP (?:429|5\d\d)|API Error: (?:429|5\d\d)|overloaded/i;
const REPORTED_USAGE=/: \d+ input \/ \d+ output tokens reported\.$/;
const RESUMED=/^(?:Worker resumed explicitly|Worker queued|Orchestrator session \S+ launched)/;
const ERROR_FIELDS=['error','lastError','errorMessage','failureReason','stopReason','reason'];

export const RETRY={
 provider:'Provider access rejected. Check request compatibility and account access; do not enable payments or raise limits automatically. Nothing was marked complete.',
 budget:'Budget stop: the spending limit blocked further requests. Nothing was reset or raised. Create a new task with an explicit budget to continue; resuming this worker stays blocked.',
 context:'Context limit: this worker cannot continue the same conversation. Create a new task from the saved instructions; the existing worktree stays in Orchestrator for inspection and salvage.',
 error:'Worker error: the output may be incomplete. Inspect the transcript and workspace, then resume explicitly or create a new task. Nothing was marked complete.'
};

// Only events after the last launch or explicit resume describe the current stop.
// Older failures must not block a worker the user has deliberately resumed.
function currentEvents(events=[]){
 let start=0;
 events.forEach((e,i)=>{if(e?.kind==='service'&&RESUMED.test(e.text??''))start=i;});
 const current=events.slice(start);
 let lastSuccess=-1;
 current.forEach((e,i)=>{if(e?.kind==='usage'&&REPORTED_USAGE.test(e.text??''))lastSuccess=i;});
 return current.filter((e,i)=>{
  if(!['error','budget'].includes(e?.kind))return false;
  // A later completed, usage-reported response demonstrates recovery from a
  // transport/provider interruption only. It does not prove task completion,
  // or clear a spending/context stop or an unrelated worker/tool failure.
  const text=e.text??'';
  return !(i<lastSuccess&&TRANSIENT.test(text)&&!BUDGET.test(text)&&!CONTEXT.test(text));
 });
}

// Returns {outcome:'success'|'blocked'|'error', kind, reason, retry}.
// Success means no explicit stop evidence exists for an idle or exited session.
export function classifyStop(session={},events=[]){
 const texts=[...ERROR_FIELDS.map(k=>session[k]),...currentEvents(events).map(e=>e.text)].filter(x=>typeof x==='string'&&x.trim());
 const text=texts.join('\n');
 if(CONTEXT.test(text))return {outcome:'blocked',kind:'context',reason:firstLine(text,CONTEXT),retry:RETRY.context};
 if(BUDGET.test(text))return {outcome:'blocked',kind:'budget',reason:firstLine(text,BUDGET),retry:RETRY.budget};
 if(PROVIDER_ACCESS.test(text))return {outcome:'blocked',kind:'provider',reason:firstLine(text,PROVIDER_ACCESS),retry:RETRY.provider};
 if(ERROR.test(text))return {outcome:'error',kind:'worker-error',reason:firstLine(text,ERROR),retry:RETRY.error};
 return {outcome:'success',kind:null,reason:null,retry:null};
}

// Returns the readable stop record kept on the task, or null for a clean stop.
export function stopReport(session,events){
 const stop=classifyStop(session,events);
 return stop.outcome==='success'?null:{outcome:stop.outcome,kind:stop.kind,reason:stop.reason,retry:stop.retry};
}

function firstLine(text,pattern){
 const line=text.split(/\r?\n/).find(l=>pattern.test(l))??text.split(/\r?\n/)[0];
 return line.trim().slice(0,300);
}
