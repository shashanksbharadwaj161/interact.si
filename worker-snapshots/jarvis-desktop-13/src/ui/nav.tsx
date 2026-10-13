import type { ComponentType } from 'react';
import { ChatCircleDots, CheckSquare, Code, Cube, Desktop, Flask, GearSix, House, Note, Pulse, Robot } from '@phosphor-icons/react';

export type ViewId = 'home' | 'assistant' | 'companion' | 'capsules' | 'notes' | 'tasks' | 'computer' | 'status' | 'settings' | 'lab' | 'developer';

export type ViewDef = { id: ViewId; label: string; icon: ComponentType<{ size?: number | string; weight?: 'regular' | 'fill' | 'duotone'; 'aria-hidden'?: boolean }>; group: string };

export const VIEWS: ViewDef[] = [
  { id: 'home', label: 'Home', icon: House, group: 'Cockpit' },
  { id: 'assistant', label: 'Assistant', icon: ChatCircleDots, group: 'Cockpit' },
  { id: 'companion', label: 'Companion', icon: Robot, group: 'Cockpit' },
  { id: 'capsules', label: 'Capsules', icon: Cube, group: 'Work' },
  { id: 'notes', label: 'Notes', icon: Note, group: 'Work' },
  { id: 'tasks', label: 'Tasks & focus', icon: CheckSquare, group: 'Work' },
  { id: 'computer', label: 'Computer', icon: Desktop, group: 'Work' },
  { id: 'status', label: 'System status', icon: Pulse, group: 'System' },
  { id: 'settings', label: 'Settings', icon: GearSix, group: 'System' },
  { id: 'lab', label: 'Feature Lab', icon: Flask, group: 'System' },
  { id: 'developer', label: 'Developer', icon: Code, group: 'System' },
];

export const VIEW_IDS = VIEWS.map((v) => v.id);

export function viewFromHash(hash: string): ViewId {
  const id = hash.replace(/^#\/?/, '') as ViewId;
  return VIEW_IDS.includes(id) ? id : 'home';
}
