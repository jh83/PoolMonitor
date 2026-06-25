const verbose = ['1', 'true', 'yes'].includes(
  String(process.env.POLL_VERBOSE || '').toLowerCase(),
);

export function isPollVerbose() {
  return verbose;
}

export function pollLog(message) {
  console.log(`[poll] ${message}`);
}

export function pollError(message) {
  console.error(`[poll] ${message}`);
}

export function pollVerbose(label, data) {
  if (!verbose) return;
  const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  console.log(`[poll:verbose] ${label}\n${body}`);
}
