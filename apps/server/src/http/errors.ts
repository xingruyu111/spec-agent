export function errorStatus(code: string): number {
  if (
    code === 'E_TASK_NOT_FOUND' ||
    code === 'E_NODE_NOT_FOUND' ||
    code === 'E_RUN_NOT_FOUND' ||
    code === 'E_CHECKPOINT_NOT_FOUND'
  ) {
    return 404;
  }
  return 409;
}
