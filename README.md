# Pool heater dashboard

A lightweight self-hosted dashboard for monitoring and predicting pool heating time,
pulling live data from Home Assistant via the REST API.

Settings and chart history are persisted on the server. Polling runs in the background
inside the container, so data collection continues when you close the browser.

## Structure

```
pool-dashboard/
├── Dockerfile
├── docker-compose.yml
├── server/
│   ├── index.js
│   ├── store.js
│   ├── ha.js
│   └── prediction.js
├── www/
│   └── index.html
└── README.md
```

## Setup

### 1. Home Assistant — long-lived access token

1. Go to your HA profile (bottom-left avatar)
2. Scroll to **Security** → **Long-lived access tokens**
3. Create a token, copy it — you only see it once

The dashboard server talks to Home Assistant directly, so **CORS configuration in HA is not required**.

### 2. Run the container

```bash
docker compose up -d --build
```

The dashboard is now available at `http://<docker-host-ip>:8088`

### 3. Configure the dashboard

- Paste your HA URL: `http://homeassistant.local:8123`
- Paste your access token
- Update the entity IDs to match your HA setup
- Click **Connect & start polling**

Settings are saved automatically as you edit them. After you start polling once, the
container keeps polling in the background and resumes after a restart.

## Entity IDs to configure

| Field | Example entity ID |
|---|---|
| Pool water temperature | `sensor.pool_water_temperature` |
| HP outlet temp 1 | `sensor.heatpump_outlet_temp_1` |
| HP outlet temp 2 | `sensor.heatpump_outlet_temp_2` |
| Solar power (W) | `sensor.solar_power` |
| Outdoor temperature | `sensor.outdoor_temperature` |
| Heat pump power (W) | `sensor.heatpump_power` |
| Heat pump on/off | `switch.heatpump` |
| Weather forecast | `weather.forecast_home` |

You can find your entity IDs in HA under **Settings → Devices & Services → Entities**.

## Tuning the prediction

After your first real heating session, compare the predicted vs actual curve on the chart.
Each selected day uses a **00:00–23:59** time axis. The chart shows:

- **Actual water temp** — measured pool temperature
- **Predicted now** / **Initial prediction** — current and session-start forecasts
- **Target** — your target pool temperature
- **Measured air temp** — outdoor air from history
- **Forecast air temp** — hourly weather forecast (today only)
- **Solar (W)** — solar production

Use the day arrows above the chart to browse the last 30 days of history. **Scroll** on the
chart to zoom the time axis, **Shift+drag** to pan, and click legend labels to show/hide
individual lines.

The **Estimated arrival at target** card at the top updates live while polling runs.

- Actual heated **slower** than predicted → raise the **loss coefficient**
- Actual heated **faster** than predicted → lower the **loss coefficient**

The default is 15 W/m²·°C. Above-ground pools with exposed walls typically land between 12–20.

### Loss coefficient calibration

Instead of guessing the loss coefficient, you can run a **cooldown test** with the heat pump
off and no sun: the dashboard measures how fast the pool cools and back-solves the coefficient.
You can **run now** (set a duration) or **schedule for tonight** (set a time window).
Requires background polling. The test auto-aborts if the heat pump turns on or solar is detected.

### Heat pump COP

Add COP values from your heat pump manual at different outdoor air temperatures — the model
interpolates between them. Enable **auto-calibrate COP from live measurements** to refine the
curve over time from real heating data (shown as **Measured COP** on the dashboard).

### Solar

Set **Solar panel rated power** to your panel's peak wattage (e.g. 170 W). The dashboard
shows **Sun activity** as current output as a percentage of that rating. Future solar in
the prediction uses cloud coverage from the weather forecast when available.

### Weather forecast

The dashboard fetches hourly forecast data via Home Assistant's `weather.get_forecasts`
service (requires a **weather.\*** entity, e.g. `weather.forecast_home`). Forecast air
temperature appears on today's chart only. If `/api/status` shows `"forecast": null`,
verify the weather entity ID and that HA returns data for **Developer tools → Actions →
weather.get_forecasts** with type `hourly`.

## Changing the port

Edit `docker-compose.yml` and change `8088:8088` to `<yourport>:8088`, then:

```bash
docker compose up -d
```

## Data persistence

Settings and history are stored in a Docker volume (`pool-dashboard-data` at `/data` in the container).

Chart history is kept for **30 days** (older points are pruned automatically). Use the **Today** button and day arrows above the chart to navigate between days. Reconnecting no longer clears past history — only a new session marker is recorded for the initial-prediction line.

At default polling (every 30 seconds), each day stores roughly 2,880 readings. The chart
downsamples to 500 points per day when there are more readings than that.
