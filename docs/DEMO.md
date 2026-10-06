# Operator demo

Hand-run curls against the control API. Someone else owns the CRE loop. Someone else owns the display UI. This script does not start either one.

The control API is `http://localhost:8787` (`CONTROL_API_PORT`). From the repo root, `bun run services` is what brings it up. Orders from this process are paper fills.

```sh
BASE=http://localhost:8787
```

## Save the pitch evidence

Save the terminal output of each curl next to the matching `GET /audit` lines. That saved pair is the pitch evidence for the policy and halt paths when a live CRE run is not available.

Each proof section ends with `GET /audit`. Paste every curl from that section beside that response. A line matches when `events[].detail` contains the same reason you just read (`category_denied: politics`, `kill_switch_on`, `daily_loss_limit_hit`, `stop_loss_triggered`, `[PAPER]`).

The loop is what appends audit rows (`POST /audit`). These operator curls do not. Until a cycle has posted, `GET /audit` is `[]`. Save that body next to the curl output anyway.

An audit entry has this shape. `receivedAt` is when the control API stored it. `cycleId` and `events` are what the loop sent.

```json
{
  "receivedAt": "2026-10-03T12:00:00.000Z",
  "cycleId": "cycle-2026-10-03T12:00:00.000Z",
  "events": [
    { "type": "policy_blocked", "detail": "… [politics] -> category_denied: politics" },
    { "type": "halted", "detail": "kill_switch_on" },
    { "type": "cycle_end", "detail": "halted: no data purchased, no orders placed" }
  ]
}
```

The same entries are appended, one JSON object per line, to `services/.data/audit.jsonl`. Read `GET /audit` for the pitch pair. Reset does not clear this log.

If the loop is cycling during the demo, leave the kill switch or the shock in place until one cycle finishes, save the new audit entry, then go on. The loop reads policy and portfolio at the start of the cycle.

## 0. Known starting book

Run this first so the wallet numbers below match on a process that has already been used. `POST /agent/policy` merges one field and leaves `category_deny` as it is. `POST /agent/debug/reset` restores cash, clears positions, clears the PnL shock, and clears stored fills. It leaves policy and the audit log alone.

```sh
curl -sS -X POST "$BASE/agent/policy" \
  -H 'content-type: application/json' \
  -d '{"kill_switch":false}'

curl -sS -X POST "$BASE/agent/debug/reset"

curl -sS "$BASE/audit"
```

You should see `kill_switch` false and `category_deny` still `["politics"]`. The reset body is the starting paper wallet:

```json
{
  "portfolio": {
    "cash": 1000,
    "equity": 1000,
    "startOfDayEquity": 1000,
    "highWaterMark": 1000,
    "dailyPnl": 0,
    "positions": []
  }
}
```

Save both curl outputs next to this `GET /audit` body.

## 1. Politics category blocked

Default policy already denies politics. Confirm that. Do not post a new deny list.

```sh
curl -sS "$BASE/agent/state"

curl -sS "$BASE/fixtures/polymarket/markets"

curl -sS "$BASE/fixtures/kalshi/events"

curl -sS "$BASE/audit"
```

You should see `policy.category_deny` as `["politics"]`, `category_allow` as `[]`, and `kill_switch` false. The portfolio is the starting paper wallet from section 0.

In the Polymarket fixture, market `601819` is "Will Luiz Inácio Lula da Silva win the 2026 Brazilian presidential election?" and its tags include `politics`. The loop treats that tag as category `politics` and blocks the intent with `category_denied: politics`.

In the Kalshi fixture, event `KXNEXTNATOSECGEN-99` ("Who will be the next Secretary General of NATO?") has category `Elections`. The loop maps `Elections` to `politics`, so the same deny applies.

The operator needs one simulated CRE cycle after the services are up before `GET /audit` will show the `policy_blocked` line.

When the loop has completed a cycle, `GET /audit` has events with `"type": "policy_blocked"` whose `detail` contains `[politics]` and `category_denied: politics`, including that question text. Those market ids are absent from `fill_filled` events in the same cycle.

Category denial runs in the CRE loop before it submits orders. The order probes later in this script use Polymarket `2589812` (Fed rates, category economy), which is outside `category_deny`. Those probes show the hard stops. A `POST /orders` for a politics market still fills when the hard stops are clear, because this executor re-checks kill switch, daily loss, stop-loss, and cash.

Save the `/agent/state` output (the `category_deny` lines) and the fixture lines for `601819` and `KXNEXTNATOSECGEN-99` next to the `policy_blocked` audit lines.

## 2. Kill switch on, orders stop, switch off

Turn the switch on. The next loop cycle halts before it buys data or places orders. This probe shows the executor rejecting a new order immediately.

```sh
curl -sS -X POST "$BASE/agent/policy" \
  -H 'content-type: application/json' \
  -d '{"kill_switch":true}'

curl -sS -X POST "$BASE/orders" \
  -H 'content-type: application/json' \
  -d '{"cycleId":"demo-kill","orders":[{"idempotencyKey":"demo-kill-1","intent":{"venue":"polymarket","marketId":"2589812","side":"yes","size":10,"limit":0.5,"reason":"demo probe"}}]}'

curl -sS "$BASE/agent/state"
```

You should see `policy.kill_switch` true and `category_deny` still `["politics"]`. The probe fill is rejected, mode stays paper, and the book is unchanged (`cash` 1000, `positions` `[]`):

```json
{
  "cycleId": "demo-kill",
  "fills": [
    {
      "idempotencyKey": "demo-kill-1",
      "mode": "paper",
      "venue": "polymarket",
      "marketId": "2589812",
      "side": "yes",
      "size": 10,
      "limit": 0.5,
      "reason": "kill_switch_on",
      "price": 0.5,
      "status": "rejected"
    }
  ]
}
```

Leave the switch on until the loop owner finishes one cycle if you want the matching audit line. That entry has `"type": "halted"`, `"detail": "kill_switch_on"`, and a `cycle_end` detail of `halted: no data purchased, no orders placed`. Then turn the switch off:

```sh
curl -sS -X POST "$BASE/agent/policy" \
  -H 'content-type: application/json' \
  -d '{"kill_switch":false}'

curl -sS "$BASE/agent/state"

curl -sS "$BASE/audit"
```

You should see `kill_switch` false. Wallet numbers are unchanged.

`demo-kill-1` stays rejected if you post it again. The executor stores the first result for an idempotency key until reset. Read `kill_switch` on `GET /agent/state` to see that the switch is off. Later probes use a new key.

Save the policy responses, the rejected fill, and the state body next to the `halted` / `kill_switch_on` audit lines.

## 3. PnL shock that trips the stop

Run this with the kill switch off, once, from the section 0 book. `pnl` is added to the current shock. A second `-250` changes the numbers below.

`max_daily_loss` is 100, so daily PnL of -250 trips the daily-loss stop. `stop_loss_pct` is 0.2 and the high-water mark stays 1000, so the floor is 800 and equity 750 trips the drawdown stop.

```sh
curl -sS -X POST "$BASE/agent/debug/shock" \
  -H 'content-type: application/json' \
  -d '{"pnl":-250}'

curl -sS -X POST "$BASE/orders" \
  -H 'content-type: application/json' \
  -d '{"cycleId":"demo-shock","orders":[{"idempotencyKey":"demo-shock-1","intent":{"venue":"polymarket","marketId":"2589812","side":"yes","size":10,"limit":0.5,"reason":"demo probe"}}]}'

curl -sS "$BASE/agent/state"

curl -sS "$BASE/audit"
```

You should see this portfolio. `cash` stays 1000 and `positions` stays empty when the loop has not filled since reset. Paper positions are marked at entry, so a loop fill changes `cash` and `positions` and leaves `equity` and `dailyPnl` on these numbers:

```json
{
  "portfolio": {
    "cash": 1000,
    "equity": 750,
    "startOfDayEquity": 1000,
    "highWaterMark": 1000,
    "dailyPnl": -250,
    "positions": []
  }
}
```

The new order is rejected, with `"mode": "paper"` and this reason:

```text
daily_loss_limit_hit: pnl -250.00 <= -100; stop_loss_triggered: equity 750.00 <= 800.00
```

`GET /agent/state` shows the same portfolio and `kill_switch` false.

Leave the shock in place for one loop cycle. The matching audit line is `"type": "halted"` with that same reason string, plus `cycle_end` of `halted: no data purchased, no orders placed`.

Save the shock body and the rejected fill next to that `halted` audit line.

## 4. Reset to the starting paper wallet

```sh
curl -sS -X POST "$BASE/agent/debug/reset"

curl -sS "$BASE/agent/state"

curl -sS "$BASE/audit"
```

You should see the starting paper wallet again:

```json
{
  "portfolio": {
    "cash": 1000,
    "equity": 1000,
    "startOfDayEquity": 1000,
    "highWaterMark": 1000,
    "dailyPnl": 0,
    "positions": []
  }
}
```

`GET /agent/state` shows that portfolio, `kill_switch` false, and `category_deny` still `["politics"]`. Stored fills are cleared, so posting `demo-kill-1` or `demo-shock-1` again is judged against the current book instead of returning the old rejection. The audit log is still the history you saved above.

Save the reset body and the state body next to that unchanged `GET /audit` response.

## 5. Read state and audit: paper vs live

```sh
curl -sS "$BASE/agent/state"

curl -sS "$BASE/audit"
```

`GET /agent/state` is `{ "policy", "portfolio" }`. There is no mode field on it. `policy` is the rules (`category_deny`, `kill_switch`, `max_daily_loss`, `stop_loss_pct`). `portfolio` is the paper wallet: `cash`, `equity`, `startOfDayEquity`, `highWaterMark`, `dailyPnl`, `positions`. After section 4 those wallet fields are the starting book (`cash` 1000, `equity` 1000, `dailyPnl` 0, `positions` `[]`).

Execution mode is on the fill. Every `POST /orders` result from this API includes `"mode": "paper"`. The rejected probes above already show it next to `"status": "rejected"`. A fill that passes the hard stops has `"status": "filled"`, `"mode": "paper"`, and `reason` set to the intent's reason. `"mode": "live"` would be a live fill.

On `GET /audit`, read `events[]`:

- `policy_blocked` — category or other gate denial. Politics is `category_denied: politics`.
- `halted` — kill switch or a loss stop. The cycle places no orders.
- `fill_filled` or `fill_rejected` — detail starts with `[PAPER]` when the fill’s mode is paper. A filled probe looks like `[PAPER] yes 10 @ 0.5 on 2589812 (demo probe)`. A rejected one puts the halt reason in the parentheses, for example `[PAPER] yes 10 @ 0.5 on 2589812 (kill_switch_on)`. The loop writes these only for orders it actually submits. A halted cycle records `halted` and does not record a fill.
- `cycle_end` — either `halted: no data purchased, no orders placed` or a summary that ends with `filled (paper)`.

A live fill would show `"mode": "live"` on the order result and an audit detail starting with `[LIVE]`. This executor returns paper on every fill, which is how the book stays obviously paper.

Save this state body next to the audit lines that contain `[PAPER]` or `filled (paper)`. Together with the pairs from sections 1–3, that is the pitch evidence for the policy and halt paths when a live CRE run is not available.
