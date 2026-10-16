/**
 * Everything the prototype "says" is written here, in plain sight. None of it is generated: there is no model, no
 * microphone and no screen capture in this study. The numbers in the region answer are computed from the mock chart's
 * own data below, so the scripted answer is at least true about what is on the mock screen.
 */

export const SIGNUPS: readonly number[] = [52, 55, 49, 58, 61, 41, 47, 53, 58, 62, 64, 67];

function regionAnswer(): string {
  const low = Math.min(...SIGNUPS);
  const lowWeek = SIGNUPS.indexOf(low) + 1;
  const last = SIGNUPS[SIGNUPS.length - 1];
  let climb = 0;
  for (let i = SIGNUPS.length - 1; i > 0 && SIGNUPS[i] > SIGNUPS[i - 1]; i--) climb++;
  const vsFirst = Math.round(((last - SIGNUPS[0]) / SIGNUPS[0]) * 100);
  return `Week ${lowWeek} is the dip: ${low} sign-ups, the lowest of the quarter. From there it rises ${climb} weeks in a row to ${last}, the highest point and ${vsFirst}% above week 1.`;
}

export type MockTask = { id: string; title: string; due: string; tone: 'overdue' | 'today' | 'later'; done: boolean; added?: boolean };

export const INITIAL_TASKS: MockTask[] = [
  { id: 't1', title: 'Renew library card', due: 'Overdue since Wed', tone: 'overdue', done: false },
  { id: 't2', title: 'Book the dentist', due: 'Today', tone: 'today', done: false },
  { id: 't3', title: 'Send review outline to Priya', due: 'Fri', tone: 'later', done: false },
];

export type Scripted =
  | { id: string; kind: 'answer'; label: string; prompt: string; title: string; text: string; basis: string; tone?: 'error' }
  | { id: string; kind: 'act'; label: string; prompt: string; tool: string; summary: string; fields: [string, string][]; risk: string; task: MockTask; failure?: string };

export const REQUESTS: Scripted[] = [
  {
    id: 'list',
    kind: 'answer',
    label: 'What is on my list today?',
    prompt: 'What is on my list today?',
    title: 'Two things today',
    text: 'Book the dentist is due today, and Renew library card has been overdue since Wednesday. Send the review outline to Priya is due Friday.',
    basis: 'Your task list (3 open)',
  },
  {
    id: 'add',
    kind: 'act',
    label: 'Remind me to call the bank tomorrow at 10',
    prompt: 'Remind me to call the bank tomorrow at 10',
    tool: 'Create a task',
    summary: 'Add one task to your list on this computer.',
    fields: [
      ['Title', 'Call the bank'],
      ['Due', 'Tomorrow, 10:00'],
      ['Where', 'Tasks, on this computer'],
    ],
    risk: 'Changes saved work. Shown first; you confirm.',
    task: { id: 't4', title: 'Call the bank', due: 'Tomorrow 10:00', tone: 'later', done: false, added: true },
  },
  {
    id: 'move',
    kind: 'act',
    label: 'Put Terminal next to the Sheet (shows a failure)',
    prompt: 'Put Terminal next to the Sheet',
    tool: 'Move a window',
    summary: 'Move the Terminal window beside Sheet on this display.',
    fields: [
      ['Window', 'Terminal'],
      ['To', 'Right half of the display, beside Sheet'],
      ['Undo', 'Moves it back'],
    ],
    risk: 'Changes window positions only. Shown first; you confirm.',
    task: { id: 'none', title: '', due: '', tone: 'later', done: false },
    failure: 'Terminal moved, but the check afterwards found it behind Sheet, not beside it. The companion reports the result it saw, not the one it hoped for. Nothing else was changed.',
  },
  {
    id: 'mail',
    kind: 'answer',
    label: 'Email this draft to Priya (not connected)',
    prompt: 'Email this draft to Priya',
    title: 'Email is not connected',
    text: 'Sending mail needs your own Google sign-in with send permission, and that connection is not built yet. Nothing was sent. You can copy the draft, or open it in your mail app yourself.',
    basis: 'Abilities: Gmail · not connected',
    tone: 'error',
  },
];

export const REGION_REQUEST = {
  prompt: 'What stands out here?',
  title: 'The week 6 dip, then a steady climb',
  text: regionAnswer(),
  basis: 'Region you drew',
};

/** The listening preview's words, revealed one by one. It is a script, not a transcription. */
export const VOICE_LINE = 'What is on my list today?'.split(' ');

export const PERSONALITIES = [
  { id: 'steady', name: 'Steady', blurb: 'Warm, brief, plain words. The default.', sample: 'Two things today: the dentist, and the library card that slipped past Wednesday.' },
  { id: 'crisp', name: 'Crisp', blurb: 'As few words as possible. No small talk.', sample: 'Today: dentist. Overdue: library card.' },
  { id: 'playful', name: 'Playful', blurb: 'A light touch, never at your expense or about failures.', sample: 'The dentist awaits, and the library card is starting to feel ignored.' },
] as const;

/** What the companion may do. Status says what exists in the product today, not what this prototype pretends. */
export const ABILITIES = [
  { id: 'read', name: 'Read your tasks and notes', scope: 'Saved work on this computer', approval: 'No prompt; read only', status: 'In the hub today', state: 'exists' },
  { id: 'task', name: 'Create a task', scope: 'Your task list', approval: 'Shows the plan; you confirm', status: 'Next: first real tool in the companion', state: 'next' },
  { id: 'launch', name: 'Open an approved app', scope: 'Apps you list in Settings', approval: 'Windows confirmation, Cancel by default', status: 'In the hub today (Desktop actions)', state: 'exists' },
  { id: 'region', name: 'Ask about a screen region', scope: 'Only the region you draw', approval: 'You see the region before it is sent', status: 'Not built yet', state: 'none' },
  { id: 'type', name: 'Type into the app you are using', scope: 'The field you pick', approval: 'Confirm each time; original text kept', status: 'Not built yet', state: 'none' },
  { id: 'media', name: 'Media controls', scope: 'Spotify, through its own sign-in', approval: 'You connect the account yourself', status: 'Not built yet', state: 'none' },
] as const;

export const CLIPBOARD_DEMO = ['Meeting link (demo text)', 'Q3 review: wins, risks, asks', 'Flight PNR 7XK2LM (demo)'];

export const APPS = [
  { id: 'notes', name: 'Field notes' },
  { id: 'sheet', name: 'Sheet' },
  { id: 'term', name: 'Terminal' },
] as const;
