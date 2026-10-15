type StatusTask = {status: string; stopReport?: {kind: string; reason?: string; retry?: string} | null};
export function displayStatus(task: StatusTask): string;
export function taskStatusLabel(task: StatusTask): string;
