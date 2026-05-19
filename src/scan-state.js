'use strict';
const fs = require('fs/promises');
const path = require('path');

const LOCAL_DATA_DIR = process.env.DAN_AGENT_DATA_DIR || (process.env.VERCEL
  ? path.join('/tmp', 'danagent-data')
  : path.join(__dirname, '..', 'data'));
const HISTORY_FILE = path.join(LOCAL_DATA_DIR, 'scan-history.json');
const HISTORY_LIMIT = 30;

let writeQueue = Promise.resolve();
let inFlightRun = null;
let currentRun = null;

function createRunId() {
  return `scan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function ensureHistoryStore() {
  await fs.mkdir(LOCAL_DATA_DIR, { recursive: true });
  try {
    await fs.access(HISTORY_FILE);
  } catch {
    await fs.writeFile(HISTORY_FILE, '[]\n', 'utf8');
  }
}

async function readHistory() {
  await ensureHistoryStore();
  const raw = await fs.readFile(HISTORY_FILE, 'utf8');
  return JSON.parse(raw);
}

async function writeHistory(history) {
  await ensureHistoryStore();
  await fs.writeFile(HISTORY_FILE, `${JSON.stringify(history.slice(0, HISTORY_LIMIT), null, 2)}\n`, 'utf8');
}

function serializeWrite(task) {
  const next = writeQueue.then(task, task);
  writeQueue = next.catch(() => {});
  return next;
}

async function appendHistory(entry) {
  await serializeWrite(async () => {
    const history = await readHistory();
    history.unshift(entry);
    await writeHistory(history);
  });
}

function nowIso() {
  return new Date().toISOString();
}

function getCurrentRun() {
  return currentRun ? { ...currentRun } : null;
}

async function getRecentRuns() {
  return readHistory();
}

async function runWithLock(task, metadata = {}) {
  if (inFlightRun) {
    const activeRun = inFlightRun.run;
    const activePromise = inFlightRun.promise;
    return {
      digest: await activePromise,
      reused: true,
      run: getCurrentRun() || activeRun,
    };
  }

  const run = {
    id: createRunId(),
    startedAt: nowIso(),
    status: 'running',
    trigger: metadata.trigger || 'unknown',
    notify: metadata.notify !== false,
    persist: metadata.persist !== false,
    repositories: 0,
    totalIssues: 0,
    opportunities: 0,
    timingsMs: {},
  };
  currentRun = run;

  const promise = (async () => {
    try {
      const digest = await task(run);
      run.completedAt = nowIso();
      run.status = 'completed';
      run.durationMs = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
      await appendHistory({ ...run });
      return digest;
    } catch (error) {
      run.completedAt = nowIso();
      run.status = 'failed';
      run.durationMs = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
      run.error = error.message;
      await appendHistory({ ...run });
      throw error;
    } finally {
      currentRun = null;
      inFlightRun = null;
    }
  })();

  inFlightRun = { promise, run };
  return {
    digest: await promise,
    reused: false,
    run: { ...run },
  };
}

module.exports = {
  getCurrentRun,
  getRecentRuns,
  runWithLock,
};
