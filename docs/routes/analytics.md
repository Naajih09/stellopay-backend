# `src/routes/analytics.ts` — Aggregation Rollup Observability

## Overview

Exposes `GET /api/v1/analytics/:user_address` — a monthly aggregation rollup that combines:

- **Payment events** (direct P2P transfers),
- **Escrow events** (Funded / Released / Refunded), and
- **Agreement creation events** (proxy for platform activity).

Each query is a DB-side `EXTRACT(MONTH FROM ...)` grouping, filtered to the caller's address and the requested year. Results are formatted as 12-month chart data suitable for UI rendering.

### Performance characteristics

The three DB queries (payments, escrow events, agreement creations) are **independent** — they share no result dependency. The route fires them via `Promise.all()` so the wall-clock latency is `max(T_payments, T_escrow, T_agreements)` instead of the sum of the three.

Monthly BigInt amounts are converted to display numbers using a **precomputed divisor** (`10 ** DEFAULT_TOKEN_DECIMALS`) rather than calling `formatTokenAmount` 13 times per request. This eliminates repeated string formatting, BigInt exponentiation, and regex replacement per rollup.

The `MONTH_NAMES` constant is hoisted to module scope to avoid re-allocation on every request.

### Backward compatibility

- **Response shape**: unchanged — `{ year, data: ChartMonth[], total }`.
- **Sign conventions**: unchanged — all payments are summed as positive; escrow Funded is negative, Released/Refunded are positive.
- **Agreement creation proxy**: unchanged — adds `count * 1000` base units to months with no payment or escrow data.
- **`views` field name**: preserved for backward compatibility; represents a net monetary amount.

---

## Contract

### Endpoint

```
GET /api/v1/analytics/:user_address?year=<number>
```

### Path parameters

| Parameter    | Type     | Constraint                                                          |
| ------------ | -------- | ------------------------------------------------------------------- |
| user_address | `string` | Valid Starknet address (validated via `StarknetAddress` Zod schema) |

### Query parameters

| Parameter | Type     | Default      | Constraint         |
| --------- | -------- | ------------ | ------------------ |
| year      | `number` | current year | integer, 2020–2100 |

### Response shape

```json
{
  "year": 2026,
  "data": [
    { "month": "Jan", "views": 0 },
    { "month": "Feb", "views": 0 },
    { "month": "Mar", "views": 4 },
    { "month": "Apr", "views": -3 },
    { "month": "May", "views": 4 },
    { "month": "Jun", "views": 2 },
    { "month": "Jul", "views": 0 },
    { "month": "Aug", "views": 0 },
    { "month": "Sept", "views": 10 },
    { "month": "Oct", "views": 0 },
    { "month": "Nov", "views": 0 },
    { "month": "Dec", "views": 0 }
  ],
  "total": 17
}
```

| Field | Type           | Description                                                |
| ----- | -------------- | ---------------------------------------------------------- |
| year  | `number`       | Calendar year queried                                      |
| data  | `ChartMonth[]` | Exactly 12 entries (Jan → Dec), zero-filled                |
| total | `number`       | Lossless sum of every month's raw BigInt amount, formatted |

### `ChartMonth`

| Field | Type     | Description                                                 |
| ----- | -------- | ----------------------------------------------------------- |
| month | `string` | Abbreviated label: `"Jan"` … `"Dec"`                        |
| views | `number` | Net aggregated financial value (see sign conventions below) |

> **Name note:** The field is named `views` for backward compatibility with
> existing consumers. It represents a **net monetary amount**, not a view count.

### Sign conventions

All values are aggregated in **BigInt space** and converted via the precomputed
`DISPLAY_DIVISOR` (= `10 ** 6`). Amounts are aggregated across all tokens.

#### Payments

| Direction | Condition                      | Sign |
| --------- | ------------------------------ | ---- |
| All       | `payment.from` or `payment.to` | `+`  |

Payments are summed as positive regardless of direction. Netting across
incoming/outgoing in the same month produces the correct aggregate.

#### Escrow events

| Event type | Sign | Rationale                     |
| ---------- | ---- | ----------------------------- |
| Funded     | `−`  | Employer sends funds out      |
| Released   | `+`  | Contributor receives funds    |
| Refunded   | `+`  | Employer receives refund back |

#### Agreement creation proxy

Each `AgreementCreated` event adds **1000 base units** (≈ 0.001 display value)
to the month. This proxy is **only applied when no payment or escrow data
exists for that month** — real financial data always takes precedence.

---

## Telemetry & Metrics

Every invocation of the rollup endpoint is instrumented. Telemetry fires **after all three DB queries complete** (success path) or **inside the catch block** (error path), and respects the global `LOG_FORMAT` and `LOG_LEVEL` settings.

### Log format — JSON (`LOG_FORMAT=json`)

**Success:**

```json
{
  "timestamp": "2026-07-26T18:47:00.123Z",
  "level": "info",
  "operation": "analytics_monthly_rollup",
  "duration_ms": 72.14,
  "status": "success",
  "request_id": "req-abc-001",
  "user_address": "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
  "year": 2026,
  "row_counts": {
    "payments": 4,
    "escrow_events": 7,
    "agreement_creations": 2
  }
}
```

**Error (DB failure):**

```json
{
  "timestamp": "2026-07-26T18:47:05.456Z",
  "level": "error",
  "operation": "analytics_monthly_rollup",
  "duration_ms": 1204.88,
  "status": "error",
  "request_id": "req-abc-001",
  "user_address": "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
  "error": "DB connection lost"
}
```

### Log format — text (`LOG_FORMAT=text`)

```text
[2026-07-26T18:47:00.123Z] INFO [analytics-telemetry] analytics_monthly_rollup success 72.14ms [req-abc-001] rows={"payments":4,"escrow_events":7,"agreement_creations":2}
```

---

## Telemetry Fields

| Field          | Type                    | Present on | Description                                        |
| -------------- | ----------------------- | ---------- | -------------------------------------------------- |
| `timestamp`    | ISO 8601 string         | always     | Log emission time                                  |
| `level`        | `"info"` / `"error"`    | always     | Log severity                                       |
| `operation`    | string                  | always     | `"analytics_monthly_rollup"`                       |
| `duration_ms`  | number                  | always     | End-to-end query + aggregation latency             |
| `status`       | `"success"` / `"error"` | always     | Outcome                                            |
| `request_id`   | string                  | when set   | Correlation ID from `res.locals.requestId`         |
| `user_address` | string                  | always     | Normalized Starknet address                        |
| `year`         | number                  | success    | Year used for date range filter                    |
| `row_counts`   | object                  | success    | `{ payments, escrow_events, agreement_creations }` |
| `error`        | string                  | error      | Error message                                      |

---

## Error responses

| Status | Condition                        | Body                                                 |
| ------ | -------------------------------- | ---------------------------------------------------- |
| 400    | Invalid `user_address` or `year` | `{ "error": "Validation failed", "details": [...] }` |
| 500    | DB failure or unexpected error   | `{ "error": "<message>" }`                           |

---

## Security Notes

- `duration_ms` is total DB round-trip time for all three queries, useful as a latency gauge against slow queries or pool exhaustion.
- `row_counts` is a diagnostic metric; it does not leak per-row data or PII.
- `user_address` in logs is the **normalized** form; no raw user input appears in logs.

---

## Edge cases intentionally out of scope

| Item                      | Reason                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Per-query timers          | All three queries run in parallel via `Promise.all()`; the aggregate duration is sufficient for diagnosing slow paths. Per-query breakdown can be added if needed. |
| Token-specific breakdowns | Amounts are aggregated across all tokens with `DEFAULT_TOKEN_DECIMALS`; per-token aggregation requires schema changes.                                             |
| Caching / memoization     | No caching is applied at the route layer; the route is a pure read that should reflect fresh DB state.                                                             |
| WCAG / accessibility      | Not applicable to this server-side route.                                                                                                                          |
