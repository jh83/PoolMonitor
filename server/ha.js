export async function haGet(config, entity) {
  const url = config.haUrl.replace(/\/$/, '');
  const res = await fetch(`${url}/api/states/${entity}`, {
    headers: {
      Authorization: `Bearer ${config.haToken.trim()}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`${entity} → HTTP ${res.status}`);
  return res.json();
}

function normalizeForecast(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const entries = raw
    .map((fc) => ({
      ...fc,
      datetime: fc.datetime ?? fc.time ?? fc.forecast_time ?? null,
      temperature: fc.temperature ?? fc.native_temperature ?? fc.temp ?? null,
    }))
    .filter((fc) => fc.temperature != null && !isNaN(+fc.temperature));
  return entries.length ? entries : null;
}

function extractForecastFromResponse(data, entity) {
  if (!data || typeof data !== 'object') return null;
  if (data.service_response?.[entity]?.forecast) return data.service_response[entity].forecast;
  if (data[entity]?.forecast) return data[entity].forecast;
  if (Array.isArray(data)) return data;
  for (const v of Object.values(data)) {
    if (v?.forecast?.length) return v.forecast;
    if (Array.isArray(v) && v[0]?.temperature != null) return v;
    if (Array.isArray(v) && v[0]?.native_temperature != null) return v;
  }
  return null;
}

export async function haForecast(config, entity) {
  const url = config.haUrl.replace(/\/$/, '');
  const headers = {
    Authorization: `Bearer ${config.haToken.trim()}`,
    'Content-Type': 'application/json',
  };

  const bodies = [
    { entity_id: entity, type: 'hourly' },
    { entity_id: [entity], type: 'hourly' },
    { target: { entity_id: [entity] }, type: 'hourly' },
  ];

  for (const body of bodies) {
    try {
      const res = await fetch(
        `${url}/api/services/weather/get_forecasts?return_response`,
        { method: 'POST', headers, body: JSON.stringify(body) },
      );
      if (!res.ok) continue;
      const data = await res.json();
      const normalized = normalizeForecast(extractForecastFromResponse(data, entity));
      if (normalized) return normalized;
    } catch {
      // try next body format
    }
  }

  try {
    const state = await haGet(config, entity);
    return normalizeForecast(state.attributes?.forecast);
  } catch {
    return null;
  }
}

export async function fetchPoolState(config) {
  const e = config.entities;
  const [poolS, out1S, out2S, solarS, outdoorS, hpPwrS, hpStateS] = await Promise.all([
    haGet(config, e.poolTemp),
    haGet(config, e.outlet1),
    haGet(config, e.outlet2),
    haGet(config, e.solar),
    haGet(config, e.outdoor),
    haGet(config, e.hpPower),
    haGet(config, e.hpState),
  ]);

  const state = {
    poolTemp: parseFloat(poolS.state),
    outlet1: parseFloat(out1S.state),
    outlet2: parseFloat(out2S.state),
    solar: parseFloat(solarS.state),
    outdoor: parseFloat(outdoorS.state),
    hpPower: parseFloat(hpPwrS.state),
    hpState: hpStateS.state,
    wind: 0,
  };

  let forecast = null;
  try {
    forecast = await haForecast(config, e.weather);
    if (forecast?.[0]?.wind_speed) state.wind = forecast[0].wind_speed;
  } catch {
    // forecast is optional
  }

  return { state, forecast };
}
