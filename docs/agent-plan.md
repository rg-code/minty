# Plan: an optional finance agent for Minty

**Status: decisions made (2026-10-06, §10); next is A0 (§8.1).** Nothing is built yet. Written 2026-09-29.

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

Checked on 2026-10-06:
- OpenRouter lists 17 free models (`:free`) that support tool calling, e.g. Gemma 4 26B/31B,
  Nemotron 3 Super/Ultra, Inkling. Free models allow **20 requests/minute** and **50 requests/day**
  (1,000/day once an account has bought 10+ credits).
  ([models API](https://openrouter.ai/api/v1/models), [limits](https://openrouter.ai/docs/api-reference/limits))
- OpenRouter's account settings decide whether requests may go to providers that **train on your
  data**, with separate settings for free and paid models. Whether the free tool-calling models are
  available with training off isn't documented; A0 tests it.
  ([privacy](https://openrouter.ai/docs/features/privacy-and-logging))
- A ChatGPT Plus or Claude Pro **subscription can't be used by other apps** and doesn't include
  API access. Minty can use an **API key** (platform.openai.com, console.anthropic.com), which is
  billed per use, separately; neither has a free API tier.

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

**Chosen (§10):** OpenRouter's free models by default; a household's own OpenAI or Anthropic API
key as an option (paid per use, so off by default and always under the daily caps).

**How keys are stored (decision 1; chosen: A):**
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
 system prompt: today, timezone, people (from MINTY_USERS), rules
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
| **A0 Spikes** | See §8.1: pick a free model by testing tool calling on synthetic data, check it works with training disallowed, and estimate CPU per step | Results recorded in this doc |
| **A1 Query layer, no AI** | Extend `/transactions` (already filters by banks and cards since #18/#19) with amount range, category and pending; add totals by group, merchant matching, result sets, `/?set=` in the dashboard and CSV export. Useful even with the agent off | Tests pass with a real local D1 |
| **A2 Agent with tagging** | OpenAI-compatible adapter (OpenRouter, OpenAI), `/agent/step`, chat panel, budgets, Setup checks, and `tag_transactions` with preview + **Confirm** (decision 3). Tests with a **fake model**, like the fake Plaid used today | The example works end to end on test data, and tagging needs a confirm |
| **A3 Anthropic adapter** | A household's own Anthropic API key (decision 2) | Same tests pass with the Anthropic adapter |
| **A4 Per-person sign-in** | Deferred: decision 1 chose a household secret | — |
| **A5 Optional** | Streamed replies, AI Gateway, the free Workers AI model, and an MCP server offering the same tools to Claude Desktop and similar apps | Separate go-aheads |

### 8.1 A0 in detail (proposed; needs a go-ahead)

1. **Fewer steps per question.** At 50 free requests a day, every step counts. Put the account
   list (bank, name, mask, person) in the system prompt, and let `search_transactions` match
   merchants loosely, so the example takes 2 requests (search, then answer) instead of 4.
2. **Spike script `scripts/agent-spike.ts`, run by the owner** (it reads the OpenRouter key from
   `.dev.vars`, which Claude never reads). It uses **synthetic demo data only**: no real
   transactions leave the machine. It asks a fixed set of questions (the Amex example, an
   ambiguous one, a totals one, a tagging one) on 2–3 free models and reports, per model: whether
   it chose the right tools with valid arguments, steps used, latency and tokens. Run with the
   account's "may train on inputs" setting **off**, to learn which free models still work.
   About 40 requests in total, inside one day's free allowance.
3. **CPU estimate:** time the Worker-side part of one step (build the prompt, parse a model reply,
   run a tool on local D1) in workerd with canned replies. Confirm on the live Worker's Metrics
   after A2, with the agent switched on only there.
4. Record the chosen default model, the numbers and any design changes here.

**Rule updates (need approval, applied in A2):** CLAUDE.md gains the agent rules: tools are the
only way the model reaches data, no model-written SQL, writes need confirmation, and whichever
key-storage option is chosen.

## 9. Decisions (made 2026-10-06; see §10)

1. **Keys:** A, one household secret.
2. **Provider:** OpenRouter's free models by default, plus a household's own OpenAI or Anthropic
   API key as an option.
3. **Writes:** tagging with preview + Confirm from the first agent release (A2).
4. **Plan:** free Workers plan only. If steps don't fit, redesign rather than upgrade.

## 10. Decision log

(Filled in as decisions are made.)

- **2026-09-30:** chosen as the next step, now that the household runs on Plaid production
  (4 banks linked). The owner reports no CPU overruns from the hourly sync on the free plan.
  A0 still has to measure agent steps, which are a different workload. §9 decisions still pending.
- **2026-10-06: the four decisions** (owner):
  1. Keys: **one household secret** (Worker secret), like the Plaid keys. Per-person OpenRouter
     sign-in is deferred.
  2. Provider: **OpenRouter free models** by default, plus **existing OpenAI or Anthropic API
     keys** as an option for households that have them. Subscriptions (ChatGPT Plus, Claude Pro)
     can't be used; API keys are billed per use, so they stay optional and under the daily caps.
  3. Writes: **tagging with Confirm from the start**, so A2 includes `tag_transactions`.
  4. **Free Workers plan only**: if A0 shows steps don't fit, shrink them rather than upgrade.
  - Consequences: the 50-requests/day free limit makes steps per question the main budget (§8.1
    step 1), and the training setting for free models is a privacy question A0 must answer before
    any real transaction is sent.
