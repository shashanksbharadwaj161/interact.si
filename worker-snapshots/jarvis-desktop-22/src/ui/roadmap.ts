/**
 * Honest status of the roadmap in docs/product-roadmap.md as of this UI.
 *  - 'ui'      : an interface exists in this build. Whether it works end to end depends on the backend /
 *                installed local components; the note says what that depends on.
 *  - 'planned' : roadmap item, nothing built yet.
 *  - 'research': experimental scope; feasibility and licensing not validated.
 * Nothing here is claimed as "shipped"; live availability is shown from getSystemInfo capabilities.
 */
export type RoadmapStatus = 'ui' | 'planned' | 'research';
export type Tier = 'First' | 'Expansion' | 'Experimental';
export type RoadmapItem = { id: number; name: string; tier: Tier; status: RoadmapStatus; note?: string };
export type RoadmapCategory = { name: string; items: RoadmapItem[] };

const T: Record<string, Tier> = { F: 'First', E: 'Expansion', X: 'Experimental' };

const UI_NOTES: Record<number, string> = {
  1: 'Setup wizard with mode, permissions and hardware steps.',
  2: 'Shows what getSystemInfo reports; no dependency installer.',
  3: 'Offline default; online needs a key you provide. No automatic fallback.',
  4: 'Allowed folders and approved apps lists; actions need per-action approval.',
  5: 'Home overview built from saved data only.',
  9: 'Start-in-tray preference only; notification preferences are not built.',
  11: 'Chat is wired to the backend; needs a local model endpoint that is actually running.',
  13: 'Speak button calls the backend; works only if it reports a speech engine.',
  21: 'Text chat without streaming.',
  22: 'Push-to-talk records WAV for backend.transcribe; needs a local recognizer.',
  32: 'Notes with tags and search.',
  41: 'Capsules hold a description, scene and items; no goals or references yet.',
  42: 'Restore opens items and reports each outcome.',
  51: 'Tasks with due dates and checkboxes; no nested sub-items.',
  54: 'Notes cover quick text; no snippet expansion.',
  62: 'Three color themes with system fonts.',
  64: 'Reduced-motion switch and OS preference; no battery/fullscreen rules.',
  65: 'Procedural 2D companion reacts to app state in this window.',
  81: 'Computer view: preview first, explicit approval, then run.',
  101: 'Cloud model name and a protected key slot; transport is the backend’s job.',
  114: 'Export and import through the backend; no automatic backup schedule.',
};

const RESEARCH_CATS = new Set(['Avatar studio', 'Motion studio']);

function build(name: string, rows: string): RoadmapCategory {
  return {
    name,
    items: rows
      .split(';')
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => {
        const [id, label, t] = r.split('|');
        const n = Number(id);
        const tier = T[t];
        const status: RoadmapStatus = UI_NOTES[n] ? 'ui' : tier === 'Experimental' || RESEARCH_CATS.has(name) ? 'research' : 'planned';
        return { id: n, name: label, tier, status, note: UI_NOTES[n] };
      }),
  };
}

export const ROADMAP: RoadmapCategory[] = [
  build('Application & onboarding', '1|First-run setup wizard|F;2|Hardware and dependency checks|F;3|Offline/online mode selection|F;4|Permission setup and review|F;5|Main application dashboard|F;6|Searchable settings|F;7|Personal profiles and preferences|F;8|Keyboard and accessibility controls|F;9|Tray, startup, notification preferences|F;10|Help, tutorials, diagnostic status|F'),
  build('Local AI & voice', '11|Local text reasoning|F;12|Local speech recognition|F;13|Local speech playback|F;14|Local model-pack setup and offline import|F;15|Local vision model support|E;16|Local embeddings and retrieval|E;17|Model switching and version pinning|E;18|CPU/GPU and memory budgets|E;19|Model download verification and removal|E;20|Personal model fine-tuning experiments|X'),
  build('Assistant & screen tools', '21|Text chat with streaming|F;22|Push-to-talk conversation|F;23|Clean dictation with insertion preview|F;24|Selected screen-region questions|F;25|OCR and unselectable text extraction|E;26|Translation and app-specific writing tone|E;27|Approved document explanations|E;28|Error diagnosis with proposed actions|E;29|Explicit screen/app context controls|E;30|Conversation history and export|E'),
  build('Memory & journal', '31|Explicit project checkpoints|F;32|Searchable project notes and references|F;33|Opt-in application session timeline|E;34|Evidence-backed daily recaps|E;35|Draft worklog and standup updates|E;36|Correctable task/session association|E;37|Memory edit, forget, retention controls|E;38|Coding-session adapters|E;39|Continuous screen history|X;40|Meeting/system-audio capture and summaries|X'),
  build('Projects & workspaces', '41|Project capsules with goals and references|F;42|Launch apps, files, and URLs together|F;43|Save and restore supported window geometry|F;44|Project-specific visual scene|E;45|Resume recap with source references|E;46|Cross-project search|E;47|Browser-profile and tab adapters|E;48|Portable capsule export with path mapping|E;49|Deep app-state restoration adapters|X;50|Spatial project map with historical branches|X'),
  build('Everyday productivity', '51|Tasks and checklists|F;52|Reminders and timers|F;53|Focus sessions with history|F;54|Quick notes and snippets|E;55|File shelf with references|E;56|Optional clipboard history|E;57|Application launcher and recent items|E;58|Media and per-app volume controls|E;59|Calendar view and local calendar import|E;60|System, battery, and device widgets|E'),
  build('Visuals & motion', '61|Movable expanding desktop island|F;62|Original color, typography, material themes|F;63|Interruptible status and panel animations|F;64|Reduced motion, battery, fullscreen controls|F;65|Companion with assistant-state animations|E;66|Audio-reactive waveforms and effects|E;67|Animated project/scene transitions|E;68|Widget layout editor and live preview|E;69|Live wallpaper/shader scenes|X;70|Physics-driven desktop and window effects|X'),
  build('Routines & automation', '81|Approved app-launch action tools|F;82|Durable scheduled routines|F;83|Visual editable workflow steps|E;84|Conditions, bounded retries, duplicate prevention|E;85|Execution results and partial-failure history|E;86|Cancellation and pause-all controls|E;87|Undo for explicitly reversible steps|E;88|Selected file/browser action adapters|E;89|Watch-once routine recording|X;90|Cross-app semantic drag-to-action workflows|X'),
  build('Windows customization', '71|Curated optional mod catalog|F;72|Mod version and compatibility checks|F;73|Taskbar and Start menu presets|E;74|Explorer and notification presets|E;75|Save and restore customization settings|E;76|Advanced window borders, corners, transparency|X;77|Dock/genie/wobble animation packs|X;78|Resource and icon redirection packs|X;79|Virtual-desktop behavior modifications|X;80|AI-composed validated scene specifications|X'),
  build('Agents & developer tools', '91|Task board and worker status|E;92|Isolated project workspaces|E;93|Model/worker role selection|E;94|Persistent resumable agent sessions|E;95|Scoped tools and context policies|E;96|Agent logs and result inspection|E;97|Budgets and bounded task execution|E;98|Local specialist multi-agent execution|X;99|Animated worker/crew visualization|X;100|Suggested reusable skills from past runs|X'),
  build('Optional online integrations', '101|Anthropic BYOK provider|E;102|Additional optional AI providers|E;103|Web research with cited sources|E;104|Calendar account connectors|E;105|Issue-tracker draft export and approved posting|E;106|Weather/news feed widgets|E;107|Optional model/update downloads|E;108|Per-provider data previews and usage history|E;109|Encrypted cross-device sync|X;110|Community scene/widget marketplace|X'),
  build('Installation & ownership', '111|Windows installer and uninstaller|F;112|Bundled runtime and offline installation option|F;113|Local encrypted sensitive-data storage|F;114|Export/import and backup recovery|F;115|Crash recovery and safe launch|F;116|Network-denial/offline verification|F;117|Signed updates with rollback|E;118|Validated x64/ARM64 compatibility tiers|E;119|Commercial licensing without mandatory cloud check-in|E;120|Enterprise policy and managed deployment|X'),
  build('Usage dashboard', '121|Unified usage dashboard|E;122|Supported provider quota/balance adapters|E;123|Reset countdown and stale-data indicators|E;124|Local token and estimated cost ledger|E;125|Project/worker cost attribution|E;126|Budget pace and threshold alerts|E;127|Local inference performance history|E;128|Usage report export|E'),
  build('Avatar studio', '129|2D avatar geometry editor|X;130|Expression authoring library|X;131|Avatar animation timeline editor|X;132|Portable avatar pack import/export|X;133|3D avatar/model customization|X;134|Voice-driven avatar mouth/pose states|X;135|Realistic portrait animation adapter|X;136|Avatar quality/hardware profile manager|X'),
  build('Motion studio', '137|Procedural motion scene editor|X;138|Original scene/template library|X;139|AI-to-validated-scene generation|X;140|Local animation/clip export|X'),
];

export const STATUS_LABEL: Record<RoadmapStatus, string> = {
  ui: 'Interface built',
  planned: 'Planned',
  research: 'Research',
};

export const STATUS_BLURB: Record<RoadmapStatus, string> = {
  ui: 'There is a screen for this in the app. Whether it works end to end depends on the backend and on local components being installed; check System status.',
  planned: 'On the roadmap as a First or Expansion scope. Nothing has been built yet.',
  research: 'Experimental scope. Feasibility, performance and licensing are not validated, and nothing has been built.',
};
