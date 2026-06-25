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
  if (state.hpState !== 'on') {
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
