// Display-only classification: persisted task states and worker authorization
// remain owned by the backend. A resource stop is not a request for approval.
export function displayStatus(task) {
  if (['complete', 'cancelled'].includes(task.status)) return task.status;
  return ['budget', 'context', 'provider'].includes(task.stopReport?.kind) ? 'blocked' : task.status;
}

export function taskStatusLabel(task) {
  const status = displayStatus(task);
  if (status === 'blocked') return `Blocked: ${task.stopReport.kind}`;
  if (status === 'awaiting input') return 'Needs input';
  if (status === 'review') return 'Ready for review';
  return status.charAt(0).toUpperCase() + status.slice(1);
}
