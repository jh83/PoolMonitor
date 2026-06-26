const WATER_CP = 4186;

export const DEFAULT_COP_CURVE = [
  { outdoor: 15, cop: 3.4 },
  { outdoor: 28, cop: 4.2 },
];

const MIN_COP_DT = 0.5;
const MIN_COP_POWER = 200;
const MAX_VALID_COP = 15;
const CALIB_ALPHA = 0.05;
const CALIB_SIGMA = 6;

export const SOLAR_OFF_THRESHOLD = 50;
const SOLAR_ACTIVE_UTIL = 0.15;
const MIN_VALID_DROP = 0.2;
const MIN_SAMPLES = 6;

export function measureCop(prediction, state) {
  if (state.hpState !== 'on') return null;
  const power = state.hpPower || 0;
  if (power < MIN_COP_POWER) return null;

  const flowLps = prediction.flow / 60;
  const avgOutlet = ((state.outlet1 || 0) + (state.outlet2 || 0)) / 2;
  const dtWater = avgOutlet - (state.poolTemp || 0);
  if (dtWater < MIN_COP_DT) return null;

  const thermal = flowLps * WATER_CP * dtWater;
  const cop = thermal / power;
  if (!isFinite(cop) || cop <= 0 || cop > MAX_VALID_COP) return null;

  return { cop, thermal, dtWater };
}

export function calibrateCurve(baseCurve, outdoor, measuredCop, learnedCurve, alpha = CALIB_ALPHA, sigma = CALIB_SIGMA) {
  const source = learnedCurve?.length ? learnedCurve : (baseCurve?.length ? baseCurve : DEFAULT_COP_CURVE);
  return source.map((p) => {
    const weight = Math.exp(-((p.outdoor - outdoor) ** 2) / (2 * sigma * sigma));
    const cop = p.cop + alpha * weight * (measuredCop - p.cop);
    return { outdoor: p.outdoor, cop: +cop.toFixed(3) };
  });
}

export function interpolateCop(outdoorTemp, curve) {
  const points = [...(curve?.length ? curve : DEFAULT_COP_CURVE)].sort(
    (a, b) => a.outdoor - b.outdoor,
  );
  if (points.length === 0) return 4;
  if (outdoorTemp <= points[0].outdoor) return points[0].cop;
  if (outdoorTemp >= points[points.length - 1].outdoor) return points[points.length - 1].cop;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (outdoorTemp >= a.outdoor && outdoorTemp <= b.outdoor) {
      const t = (outdoorTemp - a.outdoor) / (b.outdoor - a.outdoor);
      return a.cop + t * (b.cop - a.cop);
    }
  }

  return points[points.length - 1].cop;
}

function calcLoss(prediction, poolTemp, outdoorTemp, windSpeed) {
  const dT = poolTemp - outdoorTemp;
  const windFactor = 1 + (windSpeed || 0) * 0.05;
  return prediction.loss * prediction.surface * dT * windFactor;
}

function effectiveHpMaxTemp(prediction) {
  const max = prediction.hpMaxTemp;
  if (max == null || !isFinite(max) || max <= 0) return Infinity;
  return max;
}

export function effectiveHpMinTemp(prediction) {
  const min = prediction.hpMinTemp;
  if (min != null && isFinite(min)) return min;
  const target = prediction.target;
  if (target != null && isFinite(target)) return target - 2;
  return null;
}

export function isHpHeatingAllowed(prediction, poolTemp) {
  return poolTemp < effectiveHpMaxTemp(prediction);
}

export function computeLossCoefficient(samples, prediction) {
  const valid = (samples || [])
    .filter((s) => isFinite(s.poolTemp) && isFinite(s.outdoor))
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));

  if (valid.length < MIN_SAMPLES) {
    return { valid: false, reason: `Too few samples (${valid.length}/${MIN_SAMPLES})`, samplesUsed: valid.length };
  }

  const tStart = valid[0].poolTemp;
  const tEnd = valid[valid.length - 1].poolTemp;
  const drop = tStart - tEnd;
  const durationMin = (new Date(valid[valid.length - 1].ts) - new Date(valid[0].ts)) / 60000;

  if (drop < MIN_VALID_DROP) {
    return {
      valid: false,
      reason: drop < 0 ? 'Pool warmed up during test' : `Temperature drop too small (${drop.toFixed(2)}°C)`,
      samplesUsed: valid.length,
      tStart,
      tEnd,
      drop: +drop.toFixed(2),
      durationMin: +durationMin.toFixed(0),
    };
  }

  let lossIntegral = 0;
  for (let i = 0; i < valid.length - 1; i++) {
    const a = valid[i];
    const b = valid[i + 1];
    const dtSec = (new Date(b.ts) - new Date(a.ts)) / 1000;
    if (dtSec <= 0) continue;
    const avgDT = ((a.poolTemp - a.outdoor) + (b.poolTemp - b.outdoor)) / 2;
    const avgWind = ((a.wind || 0) + (b.wind || 0)) / 2;
    const windFactor = 1 + avgWind * 0.05;
    lossIntegral += avgDT * windFactor * dtSec;
  }

  if (lossIntegral <= 0) {
    return {
      valid: false,
      reason: 'Pool was not warmer than surroundings — cannot estimate loss',
      samplesUsed: valid.length,
      tStart,
      tEnd,
      drop: +drop.toFixed(2),
      durationMin: +durationMin.toFixed(0),
    };
  }

  const energyLost = prediction.volume * WATER_CP * drop;
  const loss = energyLost / (prediction.surface * lossIntegral);

  return {
    valid: true,
    reason: null,
    loss: +loss.toFixed(2),
    samplesUsed: valid.length,
    tStart: +tStart.toFixed(2),
    tEnd: +tEnd.toFixed(2),
    drop: +drop.toFixed(2),
    durationMin: +durationMin.toFixed(0),
  };
}

function calcHpHeat(prediction, state) {
  if (state.hpState !== 'on' || !isHpHeatingAllowed(prediction, state.poolTemp)) {
    return { hpHeat: 0, cop: null };
  }

  const flowLps = prediction.flow / 60;
  const avgOutlet = ((state.outlet1 || 0) + (state.outlet2 || 0)) / 2;
  const dtWater = avgOutlet - (state.poolTemp || 0);
  const flowHeat = Math.max(0, flowLps * WATER_CP * dtWater);

  const cop = interpolateCop(state.outdoor, prediction.copCurve);
  const copHeat = Math.max(0, (state.hpPower || 0) * cop);

  return { hpHeat: Math.max(flowHeat, copHeat), cop };
}

export function solarUtilization(solarW, ratedW) {
  if (!ratedW || ratedW <= 0) return null;
  return Math.max(0, (solarW || 0) / ratedW);
}

export function isSolarActive(solarW, ratedW) {
  if (ratedW > 0) return solarUtilization(solarW, ratedW) > SOLAR_ACTIVE_UTIL;
  return (solarW || 0) > SOLAR_OFF_THRESHOLD;
}

function solarWattsForStep(prediction, measuredSolar, forecast, futureMin) {
  const rated = prediction.solarRatedW;
  if (!rated || rated <= 0) return measuredSolar || 0;
  if (futureMin <= 0) return measuredSolar || 0;
  if (!forecast?.length) return measuredSolar || 0;

  const hi = Math.min(Math.floor(futureMin / 60), forecast.length - 1);
  const fc = forecast[hi];
  if (fc?.cloud_coverage != null) {
    return rated * (1 - fc.cloud_coverage / 100);
  }
  return measuredSolar || 0;
}

export function calcNetPower(prediction, state, forecast = null, futureMin = 0) {
  const { hpHeat, cop } = calcHpHeat(prediction, state);
  const measuredSolar = state.solar || 0;
  const solarW = solarWattsForStep(prediction, measuredSolar, forecast, futureMin);
  const solar = solarW * prediction.solarEff;
  const loss = calcLoss(prediction, state.poolTemp, state.outdoor, state.wind);
  const solarUtil = solarUtilization(measuredSolar, prediction.solarRatedW);
  return { net: hpHeat + solar - loss, hpHeat, solar, loss, cop, solarUtil, solarW };
}

export function buildPrediction(prediction, startTemp, state, forecast) {
  const target = prediction.target;
  const mass = prediction.volume;
  if (startTemp >= target) return { minutes: 0, curve: [] };

  let temp = startTemp;
  const curve = [];
  const stepMin = 5;
  const stepSec = stepMin * 60;

  for (let i = 0; i < (24 * 60) / stepMin; i++) {
    const futureMin = i * stepMin;
    let outdoorHere = state.outdoor;
    let windHere = state.wind || 0;

    if (forecast?.length > 0) {
      const hi = Math.min(Math.floor(futureMin / 60), forecast.length - 1);
      outdoorHere = forecast[hi]?.temperature ?? outdoorHere;
      windHere = forecast[hi]?.wind_speed ?? windHere;
    }

    const { net } = calcNetPower(
      prediction,
      { ...state, poolTemp: temp, outdoor: outdoorHere, wind: windHere },
      forecast,
      futureMin,
    );
    temp = Math.min(temp + (net * stepSec) / (mass * WATER_CP), 45);
    curve.push({ t: futureMin + stepMin, temp: +temp.toFixed(2) });
    if (temp >= target) break;
  }

  const reached = curve.find((p) => p.temp >= target);
  return { minutes: reached ? reached.t : null, curve };
}

const SCHEDULE_STEP_MIN = 5;

export function parseHHMM(value) {
  const [h, m] = (value || '').split(':').map(Number);
  if (!isFinite(h) || !isFinite(m)) return null;
  return h * 60 + m;
}

export function formatHHMM(minuteOfDay) {
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function parseForecastTime(value) {
  if (value == null) return NaN;
  let t = new Date(value).getTime();
  if (!isNaN(t)) return t;
  t = new Date(String(value).replace(' ', 'T')).getTime();
  return isNaN(t) ? NaN : t;
}

function toDateStrLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function dateAtMinute(dateStr, minuteOfDay) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0, 0);
}

function normalizeForecastEntries(forecast) {
  return (forecast || [])
    .map((fc) => ({
      datetime: fc.datetime ?? fc.time ?? fc.forecast_time,
      temperature: fc.temperature ?? fc.native_temperature ?? fc.temp,
      wind_speed: fc.wind_speed ?? 0,
      cloud_coverage: fc.cloud_coverage,
    }))
    .filter((fc) => fc.temperature != null && !isNaN(+fc.temperature));
}

function forecastAt(forecast, atMs, fallbackOutdoor = 20) {
  const entries = normalizeForecastEntries(forecast);
  if (!entries.length) {
    return { temperature: fallbackOutdoor, wind_speed: 0, cloud_coverage: null };
  }

  let best = entries[0];
  let bestDist = Infinity;
  for (const entry of entries) {
    const t = parseForecastTime(entry.datetime);
    if (isNaN(t)) continue;
    const dist = Math.abs(t - atMs);
    if (dist < bestDist) {
      bestDist = dist;
      best = entry;
    }
  }
  return best;
}

function plannedSolarW(prediction, forecast, atMs) {
  const rated = prediction.solarRatedW;
  if (!rated || rated <= 0) return 0;
  const fc = forecastAt(forecast, atMs);
  if (fc.cloud_coverage != null) return rated * (1 - fc.cloud_coverage / 100);
  const hour = new Date(atMs).getHours();
  if (hour < 6 || hour >= 20) return 0;
  return rated * 0.4;
}

function plannedNetPower(prediction, poolTemp, outdoor, wind, solarW, hpOn, hpPowerW) {
  let hpHeat = 0;
  let cop = null;
  if (hpOn && isHpHeatingAllowed(prediction, poolTemp)) {
    cop = interpolateCop(outdoor, prediction.copCurve);
    hpHeat = (hpPowerW || 1500) * cop;
  }
  const solar = (solarW || 0) * prediction.solarEff;
  const loss = calcLoss(prediction, poolTemp, outdoor, wind);
  return { net: hpHeat + solar - loss, hpHeat, solar, loss, cop };
}

function simulateTemp(prediction, startTemp, fromMin, toMin, dateStr, forecast, hpOnFn, hpPowerW) {
  if (toMin <= fromMin) return startTemp;
  let temp = startTemp;
  const mass = prediction.volume;
  for (let m = fromMin; m < toMin; m += SCHEDULE_STEP_MIN) {
    const atMs = dateAtMinute(dateStr, m).getTime();
    const fc = forecastAt(forecast, atMs);
    const outdoor = +fc.temperature;
    const wind = fc.wind_speed || 0;
    const solarW = plannedSolarW(prediction, forecast, atMs);
    const { net } = plannedNetPower(prediction, temp, outdoor, wind, solarW, hpOnFn(m), hpPowerW);
    temp = Math.min(temp + (net * SCHEDULE_STEP_MIN * 60) / (mass * WATER_CP), 45);
    if (temp < 0) temp = 0;
  }
  return +temp.toFixed(2);
}

/** Electrical energy (kWh) while HP is on — uses draw power (W), not thermal output. */
function computeHpElectricalKwh(prediction, startTemp, fromMin, toMin, dateStr, forecast, hpOnFn, hpPowerW) {
  if (toMin <= fromMin) return 0;
  const powerW = hpPowerW || 1500;
  let temp = startTemp;
  let wh = 0;
  const mass = prediction.volume;
  const stepH = SCHEDULE_STEP_MIN / 60;
  for (let m = fromMin; m < toMin; m += SCHEDULE_STEP_MIN) {
    const heating = hpOnFn(m) && isHpHeatingAllowed(prediction, temp);
    if (heating) wh += powerW * stepH;
    const atMs = dateAtMinute(dateStr, m).getTime();
    const fc = forecastAt(forecast, atMs);
    const outdoor = +fc.temperature;
    const wind = fc.wind_speed || 0;
    const solarW = plannedSolarW(prediction, forecast, atMs);
    const { net } = plannedNetPower(prediction, temp, outdoor, wind, solarW, hpOnFn(m), hpPowerW);
    temp = Math.min(temp + (net * SCHEDULE_STEP_MIN * 60) / (mass * WATER_CP), 45);
    if (temp < 0) temp = 0;
  }
  return +Math.max(0, wh / 1000).toFixed(2);
}

function findLatestHpStart(prediction, startTemp, dateStr, fromMin, readyMin, forecast, hpPowerW) {
  if (startTemp >= prediction.target) {
    return { startMin: fromMin, alreadyAtTarget: true };
  }

  let latest = null;
  for (let startMin = readyMin - SCHEDULE_STEP_MIN; startMin >= fromMin; startMin -= SCHEDULE_STEP_MIN) {
    const hpOnFn = (m) => m >= startMin && m < readyMin;
    const tempAtReady = simulateTemp(
      prediction, startTemp, fromMin, readyMin, dateStr, forecast, hpOnFn, hpPowerW,
    );
    if (tempAtReady >= prediction.target) {
      latest = startMin;
      break;
    }
  }

  if (latest == null) return null;
  return { startMin: latest, alreadyAtTarget: false };
}

function dayLabel(dateStr, todayStr, tomorrowStr) {
  if (dateStr === todayStr) return 'Today';
  if (dateStr === tomorrowStr) return 'Tomorrow';
  return dateStr;
}

function resolveHpOffMin(readyMin, hpOffMin) {
  if (hpOffMin == null) return readyMin;
  if (hpOffMin <= readyMin) return readyMin + SCHEDULE_STEP_MIN;
  return hpOffMin;
}

export const WEEKDAY_LABELS = {
  0: 'Sunday',
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
};

/** Monday → Sunday display order (JS getDay: 0 = Sunday). */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export function dayOfWeekFromDateStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

export function defaultWeekDays(readyTime = '10:00', hpOffTime = '20:00') {
  const days = {};
  for (let dow = 0; dow < 7; dow++) {
    days[dow] = { readyTime, hpOffTime };
  }
  return days;
}

export function normalizeScheduleConfig(scheduleConfig) {
  const readyTime = scheduleConfig?.readyTime ?? '10:00';
  const hpOffTime = scheduleConfig?.hpOffTime ?? '20:00';
  const weekly = scheduleConfig?.weekly === true;
  const weekDays = { ...defaultWeekDays(readyTime, hpOffTime) };
  const raw = scheduleConfig?.weekDays;
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(raw)) {
      const dow = Number(key);
      if (!Number.isInteger(dow) || dow < 0 || dow > 6) continue;
      weekDays[dow] = {
        readyTime: raw[key]?.readyTime ?? readyTime,
        hpOffTime: raw[key]?.hpOffTime ?? hpOffTime,
      };
    }
  }
  return {
    ...scheduleConfig,
    readyTime,
    hpOffTime,
    weekly,
    weekDays,
  };
}

export function resolveDaySchedule(scheduleConfig, dateOrDateStr) {
  const schedule = normalizeScheduleConfig(scheduleConfig);
  const dow = typeof dateOrDateStr === 'string'
    ? dayOfWeekFromDateStr(dateOrDateStr)
    : dateOrDateStr.getDay();
  const times = schedule.weekly
    ? schedule.weekDays[dow]
    : { readyTime: schedule.readyTime, hpOffTime: schedule.hpOffTime };
  const readyMin = parseHHMM(times.readyTime);
  const hpOffMin = resolveHpOffMin(readyMin, parseHHMM(times.hpOffTime));
  return {
    readyTime: times.readyTime,
    hpOffTime: formatHHMM(hpOffMin),
    readyMin,
    hpOffMin,
    dayOfWeek: dow,
  };
}

/** HP on from morning start until evening shutoff (includes heating through ready time). */
function hpOnUntilEvening(startMin, hpOffMin) {
  return (m) => m >= startMin && m < hpOffMin;
}

export function effectiveHpRatedW(prediction, state = null) {
  const kw = prediction.hpRatedKw;
  if (kw != null && isFinite(kw) && kw > 0) return kw * 1000;
  const live = state?.hpPower;
  if (live != null && isFinite(live) && live > 0) return live;
  return 1500;
}

export function buildHpSchedule(prediction, state, forecast, scheduleConfig, now = new Date()) {
  const schedule = normalizeScheduleConfig(scheduleConfig);
  const defaultDay = resolveDaySchedule(schedule, now);
  if (defaultDay.readyMin == null || !isFinite(state?.poolTemp)) {
    return {
      enabled: schedule.enabled !== false,
      weekly: schedule.weekly,
      readyTime: schedule.readyTime,
      hpOffTime: schedule.hpOffTime,
      days: [],
    };
  }

  const enabled = schedule.enabled !== false;
  const hpPowerW = effectiveHpRatedW(prediction, state);
  const todayStr = toDateStrLocal(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = toDateStrLocal(tomorrow);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  const daySet = new Set([todayStr, tomorrowStr]);
  for (const entry of normalizeForecastEntries(forecast)) {
    const t = parseForecastTime(entry.datetime);
    if (!isNaN(t)) daySet.add(toDateStrLocal(new Date(t)));
  }

  const days = [...daySet].sort().slice(0, 8);
  let carryTemp = state.poolTemp;
  const results = [];

  for (const dateStr of days) {
    const { readyMin, hpOffMin } = resolveDaySchedule(schedule, dateStr);
    if (readyMin == null) continue;

    const isToday = dateStr === todayStr;
    const simFromMin = isToday ? nowMin : 0;

    if (isToday && nowMin >= readyMin) {
      const hpOnFn = (m) => m >= nowMin && m < hpOffMin;
      carryTemp = simulateTemp(
        prediction, carryTemp, nowMin, 24 * 60, dateStr, forecast, hpOnFn, hpPowerW,
      );
      const hpKwh = computeHpElectricalKwh(
        prediction, carryTemp, nowMin, 24 * 60, dateStr, forecast, hpOnFn, hpPowerW,
      );
      results.push({
        date: dateStr,
        label: 'Today',
        status: 'past',
        message: 'Ready time already passed',
        readyTime: formatHHMM(readyMin),
        hpOffTime: formatHHMM(hpOffMin),
        hpKwh,
      });
      continue;
    }

    const startTemp = carryTemp;

    if (startTemp >= prediction.target) {
      carryTemp = simulateTemp(
        prediction, startTemp, simFromMin, 24 * 60, dateStr, forecast, () => false, hpPowerW,
      );
      results.push({
        date: dateStr,
        label: dayLabel(dateStr, todayStr, tomorrowStr),
        status: 'at_target',
        hpStart: null,
        readyTime: formatHHMM(readyMin),
        hpOffTime: formatHHMM(hpOffMin),
        projectedTemp: startTemp,
        poolTempAtStart: startTemp,
        poolTempAtOff: carryTemp,
        hpKwh: 0,
        message: 'Already at target',
      });
      continue;
    }

    const found = findLatestHpStart(
      prediction, startTemp, dateStr, simFromMin, readyMin, forecast, hpPowerW,
    );

    if (!found) {
      carryTemp = simulateTemp(
        prediction, startTemp, simFromMin, 24 * 60, dateStr, forecast, () => false, hpPowerW,
      );
      results.push({
        date: dateStr,
        label: dayLabel(dateStr, todayStr, tomorrowStr),
        status: 'impossible',
        readyTime: formatHHMM(readyMin),
        hpOffTime: formatHHMM(hpOffMin),
        poolTempAtStart: startTemp,
        poolTempAtOff: carryTemp,
        hpKwh: 0,
        message: 'Cannot reach target in time',
      });
      continue;
    }

    const hpStartMin = found.startMin;
    const dayHpOn = hpOnUntilEvening(hpStartMin, hpOffMin);
    const hpKwh = computeHpElectricalKwh(
      prediction, startTemp, simFromMin, 24 * 60, dateStr, forecast, dayHpOn, hpPowerW,
    );
    const tempAtReady = simulateTemp(
      prediction, startTemp, simFromMin, readyMin, dateStr, forecast, dayHpOn, hpPowerW,
    );
    carryTemp = simulateTemp(
      prediction, startTemp, simFromMin, 24 * 60, dateStr, forecast, dayHpOn, hpPowerW,
    );

    results.push({
      date: dateStr,
      label: dayLabel(dateStr, todayStr, tomorrowStr),
      status: found.alreadyAtTarget ? 'at_target' : 'scheduled',
      hpStart: found.alreadyAtTarget ? null : formatHHMM(hpStartMin),
      readyTime: formatHHMM(readyMin),
      hpOffTime: formatHHMM(hpOffMin),
      projectedTemp: tempAtReady,
      poolTempAtStart: startTemp,
      poolTempAtOff: carryTemp,
      heatingMinutes: found.alreadyAtTarget ? 0 : readyMin - hpStartMin,
      hpKwh: found.alreadyAtTarget ? 0 : hpKwh,
      message: found.alreadyAtTarget ? 'Already at target' : null,
    });
  }

  return {
    enabled,
    weekly: schedule.weekly,
    readyTime: schedule.readyTime,
    hpOffTime: defaultDay.hpOffTime,
    days: results,
  };
}
