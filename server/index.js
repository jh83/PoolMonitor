import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchPoolState } from './ha.js';
import { pollError, pollLog, pollVerbose } from './log.js';
import {
  buildHpSchedule,
  buildPrediction,
  calcNetPower,
  calibrateCurve,
  computeLossCoefficient,
  measureCop,
  isSolarActive,
} from './prediction.js';
import {
  appendHistoryPoint,
  getAvailableDates,
  getForecastSnapshotsForDate,
  getHistoryForDate,
  loadConfig,
  maybeAppendForecastSnapshot,
  saveConfig,
  saveHistory,
  toDateStr,
} from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8088;
const WWW_DIR = path.join(__dirname, '..', 'www');

let config = loadConfig();
let pollTimer = null;
let pollInFlight = false;
let sessionPending = false;

let runtime = {
  lastPollAt: null,
  lastError: null,
  state: null,
  forecast: null,
  powers: null,
  prediction: null,
  measuredCop: null,
  hpSchedule: null,
};

const app = express();
app.use(express.json());
app.use(express.static(WWW_DIR));

function mergeConfig(updates) {
  config = {
    ...config,
    ...updates,
    entities: { ...config.entities, ...updates.entities },
    prediction: { ...config.prediction, ...updates.prediction },
    polling: { ...config.polling, ...updates.polling },
    calibration: { ...config.calibration, ...updates.calibration },
  };

  if (updates.prediction?.copCurve && config.calibration?.learned) {
    const anchors = (curve) => curve.map((p) => p.outdoor).sort((a, b) => a - b).join(',');
    if (anchors(config.prediction.copCurve) !== anchors(config.calibration.learned)) {
      config.calibration.learned = null;
      config.calibration.sampleCount = 0;
    }
  }

  saveConfig(config);
  return config;
}

function effectiveCurve() {
  if (config.calibration?.enabled && config.calibration.learned?.length) {
    return config.calibration.learned;
  }
  return config.prediction.copCurve;
}

function effectivePrediction() {
  return { ...config.prediction, copCurve: effectiveCurve() };
}

function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function parseHHMM(value) {
  const [h, m] = (value || '').split(':').map(Number);
  if (!isFinite(h) || !isFinite(m)) return null;
  return h * 60 + m;
}

function isWithinSchedule(schedule, now = new Date()) {
  const start = parseHHMM(schedule?.start);
  const end = parseHHMM(schedule?.end);
  if (start == null || end == null) return false;
  const cur = minutesOfDay(now);
  if (start === end) return false;
  if (start < end) return cur >= start && cur < end;
  return cur >= start || cur < end;
}

function finalizeLossCalibration() {
  const lc = config.lossCal;
  const result = computeLossCoefficient(lc.samples, config.prediction);
  lc.lastResult = result;
  lc.startedAt = null;
  lc.samples = [];

  if (result.valid) {
    lc.previousLoss = config.prediction.loss;
    config.prediction.loss = result.loss;
    lc.status = 'completed';
    lc.abortReason = null;
  } else {
    lc.status = 'aborted';
    lc.abortReason = result.reason;
  }
  saveConfig(config);
}

function abortLossCalibration(reason) {
  const lc = config.lossCal;
  lc.status = 'aborted';
  lc.abortReason = reason;
  lc.startedAt = null;
  lc.samples = [];
  saveConfig(config);
}

function handleLossCalibration(state, now = new Date()) {
  const lc = config.lossCal;

  if (lc.mode === 'scheduled' && lc.status === 'armed' && isWithinSchedule(lc.schedule, now)) {
    lc.status = 'running';
    lc.startedAt = now.toISOString();
    lc.samples = [];
    lc.abortReason = null;
  }

  if (lc.status !== 'running') return;

  if (state.hpState === 'on') {
    abortLossCalibration('Heat pump turned on during test');
    return;
  }
  if (isSolarActive(state.solar, config.prediction.solarRatedW)) {
    abortLossCalibration('Solar production detected during test');
    return;
  }
  if (!isFinite(state.poolTemp) || !isFinite(state.outdoor)) {
    abortLossCalibration('Pool or outdoor temperature unavailable');
    return;
  }

  lc.samples.push({
    ts: now.toISOString(),
    poolTemp: state.poolTemp,
    outdoor: state.outdoor,
    wind: state.wind || 0,
  });

  let done = false;
  if (lc.mode === 'immediate') {
    const elapsedMin = lc.startedAt ? (now - new Date(lc.startedAt)) / 60000 : 0;
    if (elapsedMin >= lc.durationMin) done = true;
  } else if (lc.mode === 'scheduled') {
    if (!isWithinSchedule(lc.schedule, now)) done = true;
  }

  if (done) finalizeLossCalibration();
  else saveConfig(config);
}

function computeHpSchedule(state, forecast) {
  if (!state?.poolTemp) return null;
  const pred = effectivePrediction();
  return buildHpSchedule(pred, state, forecast, pred.schedule);
}

function buildStatus() {
  return {
    polling: {
      enabled: config.polling.enabled,
      intervalMs: config.polling.intervalMs,
      lastPollAt: runtime.lastPollAt,
      lastError: runtime.lastError,
    },
    state: runtime.state,
    forecast: runtime.forecast,
    powers: runtime.powers,
    prediction: runtime.prediction,
    measuredCop: runtime.measuredCop,
    hpSchedule: runtime.hpSchedule,
    calibration: {
      enabled: config.calibration.enabled,
      sampleCount: config.calibration.sampleCount,
      lastMeasuredCop: config.calibration.lastMeasuredCop,
      lastUpdated: config.calibration.lastUpdated,
      datasheet: config.prediction.copCurve,
      effective: effectiveCurve(),
    },
    lossCal: {
      status: config.lossCal.status,
      mode: config.lossCal.mode,
      schedule: config.lossCal.schedule,
      durationMin: config.lossCal.durationMin,
      startedAt: config.lossCal.startedAt,
      sampleCount: config.lossCal.samples.length,
      currentDrop:
        config.lossCal.samples.length > 1
          ? +(config.lossCal.samples[0].poolTemp -
              config.lossCal.samples[config.lossCal.samples.length - 1].poolTemp).toFixed(2)
          : 0,
      lastResult: config.lossCal.lastResult,
      previousLoss: config.lossCal.previousLoss,
      abortReason: config.lossCal.abortReason,
      currentLoss: config.prediction.loss,
    },
  };
}

async function runPoll() {
  if (pollInFlight) return;
  if (!config.haToken?.trim()) {
    runtime.lastError = 'Home Assistant token is not configured';
    return;
  }

  pollInFlight = true;
  try {
    const { state, forecast } = await fetchPoolState(config);

    handleLossCalibration(state);

    const measured = measureCop(config.prediction, state);
    if (measured && config.calibration.enabled) {
      config.calibration.learned = calibrateCurve(
        config.prediction.copCurve,
        state.outdoor,
        measured.cop,
        config.calibration.learned,
      );
      config.calibration.sampleCount = (config.calibration.sampleCount || 0) + 1;
      config.calibration.lastMeasuredCop = +measured.cop.toFixed(2);
      config.calibration.lastUpdated = new Date().toISOString();
      saveConfig(config);
    }

    const pred = effectivePrediction();
    const powers = calcNetPower(pred, state);
    const prediction = buildPrediction(pred, state.poolTemp, state, forecast);

    const nextForecast = forecast?.length ? forecast : runtime.forecast;
    runtime = {
      lastPollAt: new Date().toISOString(),
      lastError: null,
      state,
      forecast: nextForecast,
      powers,
      prediction,
      measuredCop: measured ? +measured.cop.toFixed(2) : null,
      hpSchedule: computeHpSchedule(state, nextForecast),
    };

    const point = {
      ts: runtime.lastPollAt,
      poolTemp: state.poolTemp,
      solar: state.solar,
      outdoor: state.outdoor,
    };
    const forceForecastSnapshot = sessionPending;
    if (sessionPending) {
      point.sessionStart = true;
      point.predCurve = prediction.curve;
      sessionPending = false;
    }
    appendHistoryPoint(point);
    if (nextForecast?.length) {
      maybeAppendForecastSnapshot(runtime.lastPollAt, nextForecast, forceForecastSnapshot);
    }

    const fcCount = nextForecast?.length ?? 0;
    const predMin = prediction.minutes != null ? `${Math.round(prediction.minutes)}min` : '>24h';
    pollLog(
      `OK pool=${state.poolTemp}°C outdoor=${state.outdoor}°C solar=${state.solar}W ` +
      `hp=${state.hpState}(${state.hpPower}W) forecast=${fcCount}pts pred=${predMin} ` +
      `net=${(powers.net / 1000).toFixed(2)}kW` +
      (measured ? ` cop=${measured.cop.toFixed(1)}` : ''),
    );
    pollVerbose('parsed state', state);
    if (nextForecast?.length) {
      pollVerbose('forecast', {
        count: nextForecast.length,
        first: nextForecast[0],
        last: nextForecast[nextForecast.length - 1],
      });
    }
  } catch (err) {
    runtime.lastError = err.message;
    pollError(`FAIL ${err.message}`);
    pollVerbose('error stack', err.stack);
  } finally {
    pollInFlight = false;
  }
}

function startPolling() {
  stopPolling();
  config.polling.enabled = true;
  sessionPending = true;
  saveConfig(config);
  pollLog(`started (interval ${config.polling.intervalMs}ms)`);
  runPoll();
  pollTimer = setInterval(runPoll, config.polling.intervalMs);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    pollLog('stopped');
  }
  config.polling.enabled = false;
  saveConfig(config);
}

app.get('/api/settings', (_req, res) => {
  res.json(config);
});

app.put('/api/settings', (req, res) => {
  mergeConfig(req.body);
  if (runtime.state) {
    runtime.hpSchedule = computeHpSchedule(runtime.state, runtime.forecast);
  }
  if (config.polling.enabled && pollTimer) {
    stopPolling();
    startPolling();
  }
  res.json(config);
});

app.get('/api/status', (_req, res) => {
  res.json(buildStatus());
});

app.get('/api/history', (req, res) => {
  const date = req.query.date || toDateStr(new Date());
  const dateStr = String(date);
  res.json({
    points: getHistoryForDate(dateStr),
    forecastSnapshots: getForecastSnapshotsForDate(dateStr),
  });
});

app.get('/api/history/dates', (_req, res) => {
  res.json({ dates: getAvailableDates() });
});

app.post('/api/polling/start', (req, res) => {
  if (req.body) mergeConfig(req.body);
  startPolling();
  res.json(buildStatus());
});

app.post('/api/polling/stop', (_req, res) => {
  stopPolling();
  res.json(buildStatus());
});

app.post('/api/history/clear', (_req, res) => {
  saveHistory({ points: [], forecastSnapshots: [] });
  res.json({ ok: true });
});

app.post('/api/recalculate', (req, res) => {
  if (req.body?.prediction) mergeConfig({ prediction: req.body.prediction });
  if (!runtime.state?.poolTemp) {
    res.status(400).json({ error: 'No live data yet — start polling first' });
    return;
  }
  const pred = effectivePrediction();
  const powers = calcNetPower(pred, runtime.state);
  const prediction = buildPrediction(
    pred,
    runtime.state.poolTemp,
    runtime.state,
    runtime.forecast,
  );
  runtime.powers = powers;
  runtime.prediction = prediction;
  runtime.hpSchedule = computeHpSchedule(runtime.state, runtime.forecast);
  res.json(buildStatus());
});

app.post('/api/calibration/reset', (_req, res) => {
  config.calibration.learned = null;
  config.calibration.sampleCount = 0;
  config.calibration.lastMeasuredCop = null;
  config.calibration.lastUpdated = null;
  saveConfig(config);
  res.json(buildStatus());
});

app.post('/api/loss-calibration/start', (req, res) => {
  if (!config.polling.enabled) {
    res.status(400).json({ error: 'Start background polling before running calibration' });
    return;
  }
  const durationMin = Number(req.body?.durationMin);
  config.lossCal.mode = 'immediate';
  config.lossCal.durationMin = isFinite(durationMin) && durationMin > 0 ? durationMin : 180;
  config.lossCal.status = 'running';
  config.lossCal.startedAt = new Date().toISOString();
  config.lossCal.samples = [];
  config.lossCal.abortReason = null;
  saveConfig(config);
  res.json(buildStatus());
});

app.post('/api/loss-calibration/schedule', (req, res) => {
  const { start, end } = req.body || {};
  if (parseHHMM(start) == null || parseHHMM(end) == null) {
    res.status(400).json({ error: 'Invalid start/end time (expected HH:MM)' });
    return;
  }
  config.lossCal.mode = 'scheduled';
  config.lossCal.schedule = { start, end };
  config.lossCal.status = 'armed';
  config.lossCal.startedAt = null;
  config.lossCal.samples = [];
  config.lossCal.abortReason = null;
  saveConfig(config);
  res.json(buildStatus());
});

app.post('/api/loss-calibration/cancel', (_req, res) => {
  config.lossCal.status = 'idle';
  config.lossCal.startedAt = null;
  config.lossCal.samples = [];
  config.lossCal.abortReason = null;
  saveConfig(config);
  res.json(buildStatus());
});

app.post('/api/loss-calibration/revert', (_req, res) => {
  if (config.lossCal.previousLoss == null) {
    res.status(400).json({ error: 'No previous loss value to revert to' });
    return;
  }
  config.prediction.loss = config.lossCal.previousLoss;
  config.lossCal.previousLoss = null;
  config.lossCal.status = 'idle';
  config.lossCal.lastResult = null;
  saveConfig(config);
  res.json(buildStatus());
});

app.listen(PORT, () => {
  console.log(`Pool dashboard listening on :${PORT}`);
  if (config.polling.enabled && config.haToken?.trim()) {
    startPolling();
    console.log('Resumed background polling from saved settings');
  }
});
