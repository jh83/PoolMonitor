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
│   ├── prediction.js
│   └── log.js
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

Set `POLL_VERBOSE=1` in `docker-compose.yml` to log detailed poll lines to the container log.

The dashboard is now available at `http://<docker-host-ip>:8088`

### 3. Configure the dashboard

Open **Settings** (gear icon, top right):

1. Under **Home Assistant → Connection**, paste your HA URL and access token
2. Under **Entity IDs**, update entity IDs to match your HA setup
3. Under **Data polling**, click **Connect & start polling**

Settings are saved automatically as you edit them. After you start polling once, the
container keeps polling in the background and resumes after a restart. Use **Stop polling**
in the same section when you want to pause data collection.

### Time zones

All wall-clock times in the UI (**Ready by**, **HP off**, loss-calibration window, schedule
table) are interpreted in the **container's local timezone**, not your browser's.

The default Docker image uses **UTC** unless you set `TZ`. That is why a window ending at
`05:00` can stop at **07:00 CEST** (UTC+2).

`docker-compose.yml` sets `TZ=Europe/Stockholm` by default. Change it to your IANA timezone
(e.g. `Europe/Berlin`, `Europe/Amsterdam`) or set `TZ` in a `.env` file, then recreate the
container:

```bash
docker compose up -d
```

If HA is not configured yet, the settings modal opens automatically on first visit.

## Using the dashboard

The main page is ordered for day-to-day monitoring:

1. **Header** — title with a live status dot and last poll time when polling is active
2. **At-a-glance** — primary metrics (pool temp, HP state, power, net heating, COP) and a
   secondary **Sensors** row; **Estimated arrival at target** on the right
3. **Chart** — temperature and solar history with day navigation
4. **Heat pump** — schedule, control, and temperature thresholds

Click any metric tile to open a popup chart of **today's** history for that value.

All advanced configuration lives in **Settings**, grouped into:

| Section | What it controls |
|---|---|
| **Home Assistant** | Connection, entity IDs, start/stop polling |
| **Pool & solar model** | Volume, flow, surface area, loss coefficient, solar assumptions |
| **Heat pump datasheet** | Rated electrical draw, COP curve, live COP learning |
| **Loss coefficient calibration** | Cooldown tests to refine heat loss |

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
- **Predicted now** / **Initial prediction** — current and session-start forecasts; archived
  forecast snapshots are stored hourly for past days
- **Target** — your target pool temperature
- **Measured air temp** — outdoor air from history
- **Forecast air temp** — hourly weather forecast (today only)
- **Solar (W)** — solar production

Use the day arrows above the chart to browse the last 30 days of history. **Scroll** on the
chart to zoom the time axis, **Shift+drag** to pan, and click legend labels to show/hide
individual lines.

The **Estimated arrival at target** panel updates live while polling runs.

- Actual heated **slower** than predicted → raise the **loss coefficient**
- Actual heated **faster** than predicted → lower the **loss coefficient**

The default is 15 W/m²·°C. Above-ground pools with exposed walls typically land between 12–20.

### Loss coefficient calibration

In **Settings → Loss coefficient calibration**, you can run a **cooldown test** with the heat
pump off and no sun: the dashboard measures how fast the pool cools and back-solves the
coefficient. You can **run now** (set a duration) or **schedule for tonight** (set a time
window). Requires background polling. The test auto-aborts if the heat pump turns on or solar
is detected.

### Heat pump COP

In **Settings → Heat pump datasheet**, add COP values from your manual at different outdoor
air temperatures — the model interpolates between them. Set **Rated power (kW)** to the
datasheet or measured consumption; this drives **schedule kWh** estimates (raw electrical use,
not COP-adjusted). Live **HP power** on the dashboard still comes from your HA sensor.

Enable **Auto-calibrate from live measurements** to refine the curve over time from real
heating data (shown as **Measured COP** on the dashboard).

### Daily heat pump schedule

The **Heat pump** card on the main page plans heating for today and upcoming forecast days.

Choose **Same every day** for one **Ready by** / **HP off** pair, or **Custom per weekday**
to set different times for Monday through Sunday. The forecast table uses each day's own
times when weekly mode is enabled. Auto control also follows the current day's schedule.

| Setting | Purpose |
|---|---|
| **Ready by** | Target time to reach pool temperature that day |
| **HP off (evening)** | Latest time the heat pump may run that day |
| **Target temperature** | Desired pool temperature (prediction and auto-off) |
| **HP on/off temperature — on** | Auto-control turns the HP on when pool temp drops below this |
| **HP on/off temperature — off** | Heating stops at or above this (auto control and schedule simulation) |

The table shows suggested **Start HP** times, projected temps at ready/off, **HP kWh**
(electrical consumption for the planned run), and heating duration. Overnight cooling between
days uses your loss coefficient and the air temperature forecast.

### Heat pump control

The **Control** section has **On** and **Auto** toggles that talk to your **Heat pump on/off**
switch entity in HA:

- **On** — manual on/off; syncs with live HA state (disabled while Auto is on)
- **Auto** — when enabled, within each day's schedule window (scheduled start → evening off):
  - turns **on** when pool temperature is below **HP on/off — on**
  - turns **off** at **target temperature**, **HP on/off — off**, or **HP off** time

Auto control is skipped during loss-coefficient calibration tests.

Each poll logs the auto decision to the container output (`docker compose logs -f`), for example:

```
[poll] HP auto: pool=27.9°C target=27 on=26 hp=ON window=10:00–20:00 (in window) → OFF: pool 27.9°C >= target 27°C
[poll] HP auto → OFF (switch.heatpump) — pool 27.9°C >= target 27°C
```

Turn-off follows target and max thresholds **any time before the evening off time**. Turn-on only happens inside the daily heating window (scheduled start → evening off) when pool temp is below the on threshold.

### Solar

Set **Solar panel rated power** in **Settings → Pool & solar model** to your panel's peak
wattage (e.g. 170 W). The dashboard shows **Sun activity** as current output as a percentage
of that rating. Future solar in the prediction uses cloud coverage from the weather forecast
when available.

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
downsamples to 500 points per day when there are more readings than that. Metric popup charts
use the same history; newly added metric fields only appear in history recorded after an
upgrade and rebuild.
