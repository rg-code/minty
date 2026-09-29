# Plan: an optional finance agent for Minty

**Status: proposal, decisions pending (§9).** Nothing is built yet. Written 2026-09-29.

Goal: an optional "Ask Minty" assistant that works on the household's own transactions, with
the household's choice of model provider (OpenRouter, OpenAI, Anthropic, …). For example:

> "Subset all transactions on the Amex card ending in 1234 at store XYZ in the last 10 days."

Facts checked on 2026-09-29 (re-check in A0):
- OpenRouter supports an OAuth PKCE sign-in: send the user to `https://openrouter.ai/auth`
  (`callback_url`, `code_challenge`, `code_challenge_method=S256`), then POST the returned `code`
  plus `code_verifier` to `https://openrouter.ai/api/v1/auth/keys`, which returns a
  user-controlled API key. ([docs](https://openrouter.ai/docs/use-cases/oauth-pkce))
- Workers Free plan: **10 ms CPU** per HTTP request and per cron run, **50 subrequests** per
  request, and no wall-time limit while the client stays connected. The limits page doesn't list
  Durable Objects on the Free plan, so this design doesn't rely on them.
  ([limits](https://developers.cloudflare.com/workers/platform/limits/))

## 1. Core idea

The model never touches the database. It can only call a small set of typed **tools**, which
are ordinary Minty API functions running the same parameterized queries as the dashboard. Tools
run as the signed-in person, so the agent can't do anything that person couldn't already do by
hand. Results stay on the server as **result sets**: the model sees a count, totals and a few
sample rows, and the page shows the full table.

## 2. Components

```
 Browser (dashboard)                       Cloudflare Worker (existing, behind Access)             Outside
 ┌──────────────────────┐   POST /agent/step   ┌─────────────────────────────────────┐
 │ "Ask Minty" panel     │ ───────────────────▶ │ agent/step.ts                        │  1 LLM call   ┌──────────────┐
 │  - chat               │ ◀─────────────────── │  load history ─▶ LLM adapter ────────┼─────────────▶ │ OpenRouter   │
 │  - result tables      │   {msgs, done?}      │       │ tool_calls                   │ ◀──────────── │ (or OpenAI / │
 │  - Confirm / Cancel   │                      │       ▼                              │               │  Anthropic / │
 │  - "Open in dashboard"│                      │  tools/ (typed, validated)           │               │  Workers AI) │
 └──────────────────────┘                      │   list_accounts  find_merchants      │               └──────────────┘
         ▲  same Access sign-in, same           │   search_transactions  summarize     │
         │  cross-site guard as today           │   get_rows  tag_transactions*        │
         │                                      │       │ parameterized SQL only        │
         │                                      │       ▼                              │
         │                                      │  D1: transactions / accounts / tags  │
         │                                      │      + agent_* tables (new)          │
         └── /?set=<id> opens a subset ─────────┴─────────────────────────────────────┘
                                                  * write tool: needs the user's Confirm
```

**Why step by step, driven by the browser.** Each `POST /agent/step` makes one model call, runs
that call's tools, saves everything, and returns. The browser calls again until the answer is
done. That fits the free plan: each request does little CPU work and makes few outbound calls,
and progress appears naturally ("Looking up accounts… Searching…"). The server stays in charge
of history, tools and budgets. A single long request could exceed the 50-subrequest and 10 ms
limits.

## 3. Provider sign-in

One internal interface, `chat(messages, tools, model) → {text, tool_calls, usage}`, with two
adapters:

| Adapter | Covers | Sign-in |
|---|---|---|
| OpenAI-compatible | **OpenRouter** (Claude, GPT, Gemini, Llama… with one key), OpenAI, Workers AI | OpenRouter: real sign-in (PKCE) or a pasted key; OpenAI: pasted key |
| Anthropic Messages | Anthropic directly | pasted key |

**How keys are stored (decision 1):**
- **A. One key for the household, as a Worker secret** (like the Plaid keys). Matches today's
  rule that secrets never pass through the browser or the database. Simplest.
- **B. Each person signs in to OpenRouter.** Minty sends the browser to OpenRouter, and the
  Worker trades the returned code for a key. The key never reaches the browser, is stored
  Fernet-encrypted in D1 per email, and can be revoked in Settings. Each person pays for their
  own usage. This loosens the "no secrets in the database" rule for model keys only.

Optional: route calls through **Cloudflare AI Gateway** for request logs, caching, rate limits
and spend caps. It's configuration only, with no code change.

## 4. The tools

| Tool | Input (validated) | Returns to the model |
|---|---|---|
| `list_accounts` | none | id, owner, institution, name, **mask**, type |
| `find_merchants` | `query`, limit | similar merchant names, with counts and last date |
| `search_transactions` | account_ids, owner, merchant, text, date_from/to, amount_min/max, category, tags (any/all), pending, limit | **result_set_id**, count, money out/in, the date range it actually used, and up to 20 sample rows |
| `summarize` | result_set_id, group_by (merchant, category, day, month, account) | totals per group |
| `get_rows` | result_set_id, offset, limit ≤ 50 | a page of rows |
| `tag_transactions` ✱ | result_set_id or ids, add/remove tags | a preview only; runs after **Confirm** |

Deliberately absent: raw SQL, linking banks, sync (the no-sync-endpoint rule stands), secrets,
anything that deletes, and web browsing.

## 5. The example, end to end

```
User: "subset all transactions on Amex card ending in 1234 at store XYZ in the last 10 days"
 system prompt: today = 2026-09-29, timezone, people = Me, Spouse, rules
 step 1  model → list_accounts()                       → [{id:7, "Amex Blue Cash", mask:"1234"}, …]
 step 2  model → find_merchants("XYZ")                  → [{"XYZ Store #88", n:6}, {"XYZ.com", n:2}]
 step 3  model → search_transactions({account_ids:[7], merchant:"XYZ",
                   date_from:"2026-09-19", date_to:"2026-09-29"})
                                                        → {result_set_id:"rs_41", count:5, out:$212.40,
                                                           range:"Sep 19–29", sample:[…5 rows]}
 step 4  model → "5 transactions, $212.40 at XYZ on Amex ••1234, Sep 19–29." [table rs_41]
 UI: renders rs_41 with the dashboard's row layout + [Open in dashboard] [Export CSV] [Tag all…]
 "Tag all 'reimbursable'" → tag_transactions(rs_41) → preview "5 rows" → user Confirm → saved
```

If the question is ambiguous (two Amex cards ending 1234, or several XYZ merchants), the model
asks which one instead of guessing.

## 6. Data model: migration `0003_agent.sql`

```
agent_conversations (id, email, title, model, created_at, updated_at)
agent_messages      (id, conversation_id, seq, role, content_json, tool_name, tokens_in, tokens_out, created_at)
agent_result_sets   (id, conversation_id, email, filter_json, row_count, created_at, expires_at)
agent_result_items  (result_set_id, transaction_id)         -- a snapshot of the matching rows, not a live filter
agent_usage         (day, email, tokens_in, tokens_out, cost_estimate_cents)
llm_credentials     (email, provider, key_enc, created_at)  -- only with option B
```

New settings, all off unless set:
- `AGENT_ENABLED` — the whole agent is off by default.
- `AGENT_PROVIDER` — which service to use.
- `AGENT_MODEL` — which model.
- `AGENT_MAX_STEPS` — steps per question, default 8.
- `AGENT_DAILY_TOKEN_BUDGET` — per person.
- Optional `AI_GATEWAY_URL`.
- Provider keys as secrets.

Setup checks gain agent lines, and each new setting gets a default and a line in the
`wrangler.jsonc` header, per the existing rules.

## 7. Safety and privacy

- **Opt-in:** the agent is off by default and each household turns it on. With it on, matching
  transactions are sent to the provider you picked. The data sent is kept small: merchant, amount,
  date, account name and last-4 mask, tags. Never Plaid tokens or full account numbers (Plaid
  doesn't give Minty full numbers anyway). With OpenRouter you can also require providers that
  keep no data.
- **Bank text is untrusted:** merchant names could contain text that tries to steer the model.
  The tools can't do much, writes need Confirm, and model output is always shown as plain text.
- **Existing protections:** Access and `ALLOWED_LOGINS` apply to `/agent/*`, as do the cross-site
  write guard and each person's email as their identity.
- **Budgets:** a cap on steps per question, a daily token cap per person, and a row cap per tool
  result. When a cap is hit, the agent stops with a clear message.

## 8. Phases (each ends with a PR you review)

| Phase | What | Done when |
|---|---|---|
| **A0 Spikes** | Measure CPU per step on the free plan against real OpenRouter calls; confirm tool calling on 2–3 cheap models; settle the decisions below | Numbers recorded in this doc |
| **A1 Query layer, no AI** | The query functions behind `search_transactions`, `summarize` and `find_merchants`, result sets, `/?set=` in the dashboard, CSV export. Useful even with the agent off | Tests pass with a real local D1 |
| **A2 Read-only agent** | Adapters, `/agent/step`, chat panel, budgets, Setup checks; tests with a **fake model**, like the fake Plaid used today | The example works end to end on test data (local seed data, or Sandbox) |
| **A3 Writes** | `tag_transactions` with preview and Confirm, saved subsets | Tagging a result set needs a confirm, and it's tested |
| **A4 Sign-in** | OpenRouter PKCE per person (option B), direct Anthropic and OpenAI keys | Sign in, use, revoke |
| **A5 Optional** | Streamed replies, AI Gateway, the free Workers AI model, and an MCP server offering the same tools to Claude Desktop and similar apps | Separate go-aheads |

**Rule updates (need approval, applied in A2):** CLAUDE.md gains the agent rules: tools are the
only way the model reaches data, no model-written SQL, writes need confirmation, and whichever
key-storage option is chosen.

## 9. Decisions needed before A1

1. **Keys:** A, one household secret (simplest, matches today's rules), or B, each person signs in
   to OpenRouter (keys encrypted in D1)? Or A first, B later?
2. **Default provider:** OpenRouter (one key, many models; recommended), or a direct provider?
3. **Writes:** may the agent tag transactions after you confirm, or read-only at first?
4. **Plan:** stay on the free plan (the step-by-step design is built for it), or allow Workers
   Paid ($5/month) if the A0 CPU measurements are tight?

## 10. Decision log

(Filled in as decisions are made.)
