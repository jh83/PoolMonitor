import fs from 'node:fs';
import path from 'node:path';
import { normalizeScheduleConfig } from './prediction.js';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const HISTORY_PATH = path.join(DATA_DIR, 'history.json');
export const RETENTION_DAYS = 30;

export const DEFAULT_CONFIG = {
  haUrl: 'http://homeassistant.local:8123',
  haToken: '',
  entities: {
    poolTemp: 'sensor.pool_water_temperature',
    outlet1: 'sensor.heatpump_outlet_temp_1',
    outlet2: 'sensor.heatpump_outlet_temp_2',
    solar: 'sensor.solar_power',
    outdoor: 'sensor.outdoor_temperature',
    hpPower: 'sensor.heatpump_power',
    hpState: 'switch.heatpump',
    weather: 'weather.forecast_home',
  },
  prediction: {
    target: 28,
    hpMinTemp: 26,
    hpMaxTemp: 32,
    volume: 16000,
    flow: 25,
    surface: 15,
    loss: 15,
    solarEff: 0.8,
    solarRatedW: 170,
    hpRatedKw: 1.5,
    copCurve: [
      { outdoor: 15, cop: 3.4 },
      { outdoor: 28, cop: 4.2 },
    ],
    schedule: {
      enabled: true,
      weekly: false,
      readyTime: '10:00',
      hpOffTime: '20:00',
      weekDays: null,
      autoControl: false,
    },
  },
  polling: {
    enabled: false,
    intervalMs: 30000,
  },
  calibration: {
    enabled: true,
    learned: null,
    sampleCount: 0,
    lastMeasuredCop: null,
    lastUpdated: null,
  },
  lossCal: {
    status: 'idle',
    mode: 'immediate',
    schedule: { start: '01:00', end: '05:00' },
    durationMin: 180,
    startedAt: null,
    samples: [],
    lastResult: null,
    previousLoss: null,
    abortReason: null,
  },
};

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return structuredClone(fallback);
    return { ...structuredClone(fallback), ...JSON.parse(fs.readFileSync(filePath, 'utf8')) };
  } catch {
    return structuredClone(fallback);
  }
}

function writeJson(filePath, data) {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function toDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function dayBounds(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return {
    start: new Date(y, m - 1, d, 0, 0, 0, 0),
    end: new Date(y, m - 1, d, 23, 59, 59, 999),
  };
}

export function pruneHistory(points) {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return points.filter((p) => new Date(p.ts).getTime() >= cutoff);
}

function compactPoint(point) {
  const compact = {
    ts: point.ts,
    poolTemp: point.poolTemp,
    solar: point.solar,
    outdoor: point.outdoor,
  };
  if (point.outlet1 != null && isFinite(point.outlet1)) compact.outlet1 = point.outlet1;
  if (point.outlet2 != null && isFinite(point.outlet2)) compact.outlet2 = point.outlet2;
  if (point.hpPower != null && isFinite(point.hpPower)) compact.hpPower = point.hpPower;
  if (point.hpState != null) compact.hpState = point.hpState;
  if (point.netKw != null && isFinite(point.netKw)) compact.netKw = point.netKw;
  if (point.cop != null && isFinite(point.cop)) compact.cop = point.cop;
  if (point.solarUtil != null && isFinite(point.solarUtil)) compact.solarUtil = point.solarUtil;
  if (point.sessionStart) {
    compact.sessionStart = true;
    if (point.predCurve) compact.predCurve = point.predCurve;
  }
  return compact;
}

function compactForecast(forecast) {
  if (!Array.isArray(forecast)) return [];
  return forecast
    .map((fc) => {
      const d = fc.datetime ?? fc.time ?? fc.forecast_time;
      const t = fc.temperature ?? fc.native_temperature ?? fc.temp;
      if (!d || t == null || isNaN(+t)) return null;
      return [d, +parseFloat(t)];
    })
    .filter(Boolean);
}

export function expandForecast(compact) {
  if (!Array.isArray(compact)) return [];
  return compact.map(([datetime, temperature]) => ({ datetime, temperature }));
}

function snapshotHourKey(ts) {
  return new Date(ts).toISOString().slice(0, 13);
}

export function pruneForecastSnapshots(snapshots) {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return snapshots.filter((s) => new Date(s.ts).getTime() >= cutoff);
}

function normalizePoints(points) {
  return pruneHistory(points).map((p) => {
    if (p.sessionStart) return p;
    const { predCurve, sessionStart, ...rest } = p;
    return rest;
  });
}

export function loadConfig() {
  const config = readJson(CONFIG_PATH, DEFAULT_CONFIG);
  config.entities = { ...DEFAULT_CONFIG.entities, ...config.entities };
  config.prediction = { ...DEFAULT_CONFIG.prediction, ...config.prediction };
  config.prediction.schedule = normalizeScheduleConfig({
    ...DEFAULT_CONFIG.prediction.schedule,
    ...config.prediction.schedule,
  });
  if (!Array.isArray(config.prediction.copCurve) || config.prediction.copCurve.length === 0) {
    config.prediction.copCurve = DEFAULT_CONFIG.prediction.copCurve;
  }
  config.polling = { ...DEFAULT_CONFIG.polling, ...config.polling };
  config.calibration = { ...DEFAULT_CONFIG.calibration, ...config.calibration };
  config.lossCal = { ...DEFAULT_CONFIG.lossCal, ...config.lossCal };
  config.lossCal.schedule = { ...DEFAULT_CONFIG.lossCal.schedule, ...config.lossCal.schedule };
  if (!Array.isArray(config.lossCal.samples)) config.lossCal.samples = [];
  return config;
}

export function saveConfig(config) {
  writeJson(CONFIG_PATH, config);
}

export function loadHistory() {
  const history = readJson(HISTORY_PATH, { points: [], forecastSnapshots: [] });
  if (!Array.isArray(history.points)) history.points = [];
  if (!Array.isArray(history.forecastSnapshots)) history.forecastSnapshots = [];
  history.points = normalizePoints(history.points);
  history.forecastSnapshots = pruneForecastSnapshots(history.forecastSnapshots);
  return history;
}

export function saveHistory(history) {
  history.points = normalizePoints(history.points);
  if (!Array.isArray(history.forecastSnapshots)) history.forecastSnapshots = [];
  history.forecastSnapshots = pruneForecastSnapshots(history.forecastSnapshots);
  writeJson(HISTORY_PATH, history);
}

export function appendHistoryPoint(point) {
  const history = loadHistory();
  history.points.push(compactPoint(point));
  history.points = normalizePoints(history.points);
  saveHistory(history);
  return history;
}

export function maybeAppendForecastSnapshot(ts, forecast, force = false) {
  const compact = compactForecast(forecast);
  if (!compact.length) return;

  const history = loadHistory();
  const last = history.forecastSnapshots[history.forecastSnapshots.length - 1];
  if (!force && last && snapshotHourKey(last.ts) === snapshotHourKey(ts)) return;

  history.forecastSnapshots.push({ ts, f: compact });
  history.forecastSnapshots = pruneForecastSnapshots(history.forecastSnapshots);
  saveHistory(history);
}

export function getForecastSnapshotsForDate(dateStr) {
  const { start, end } = dayBounds(dateStr);
  const windowStart = new Date(start);
  windowStart.setDate(windowStart.getDate() - 1);
  const startMs = windowStart.getTime();
  const endMs = end.getTime();
  return loadHistory().forecastSnapshots.filter((s) => {
    const t = new Date(s.ts).getTime();
    return t >= startMs && t <= endMs;
  });
}

export function getHistoryForDate(dateStr) {
  const { start, end } = dayBounds(dateStr);
  const startMs = start.getTime();
  const endMs = end.getTime();
  return loadHistory().points.filter((p) => {
    const t = new Date(p.ts).getTime();
    return t >= startMs && t <= endMs;
  });
}

export function getAvailableDates() {
  const dates = new Set();
  for (const p of loadHistory().points) {
    dates.add(toDateStr(new Date(p.ts)));
  }
  return [...dates].sort();
}
