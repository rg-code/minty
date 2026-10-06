# Plan: an optional finance agent for Minty

**Status: decisions made (2026-10-06, §10); next is A0 (§8.1).** Nothing is built yet. Written 2026-09-29.

Goal: an optional "Ask Minty" assistant that works on the household's own transactions, with
the household's choice of model provider (OpenRouter, OpenAI, Anthropic, …). For example:

> "Subset all transactions on the Amex card ending in 1234 at store XYZ in the last 10 days."

…and that can also work in the background: "tell me when this pending hotel charge posts", "tag
anything at Uber or Lyft as transport", "every Monday, write me a note on last week's spending
compared with usual". Those are examples, not the limit: automations can use exact rules or AI
judgement (§4.1). The scope is strictly the household's own Minty data.

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
- A ChatGPT Plus or Claude Pro **subscription isn't API access.** Minty can use an **API key**
  (platform.openai.com, console.anthropic.com), billed per use, separately from any subscription;
  neither has a free API tier.
  - **Anthropic:** since February 2026 its terms prohibit using Claude subscription logins (OAuth
    tokens) in third-party tools, enforced from April 2026 (with later partial reversals).
    ([The Register](https://www.theregister.com/software/2026/02/20/anthropic-clarifies-ban-on-third-party-tool-access-to-claude/5014546),
    [VentureBeat](https://venturebeat.com/technology/anthropic-cuts-off-the-ability-to-use-claude-subscriptions-with-openclaw-and))
  - **OpenAI:** "Sign in with ChatGPT" (DevDay, 2026-09-29) lets Plus/Pro plans pay for usage in
    participating apps, with a weekly per-app cap. It's a limited preview for 16 partners; others
    apply via an interest form. Minty can't use it today.
    ([The New Stack](https://thenewstack.io/sign-in-with-chatgpt/),
    [interest form](https://openai.com/form/sign-in-with-chatgpt-interest/))
  - Subscription bridges (CLIProxyAPI, codex-lb and similar) are **not supported**: see §10,
    2026-10-06 (revised).
- **Workers AI** (Cloudflare's own models) works on the **free plan**: 10,000 Neurons a day at no
  charge; past that, requests are **blocked, not billed** (the free plan can't buy more). Example
  rates for Llama 3.3 70B: 26,668 Neurons per million input tokens, 204,805 per million output.
  ([pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/))
  - Models marked for tool calling include GLM-5.x, Kimi K2.6 and Hermes 2 Pro; a recent changelog
    entry fixed multi-turn tool calls. ([models](https://developers.cloudflare.com/workers-ai/models/),
    [function calling](https://developers.cloudflare.com/workers-ai/features/function-calling/),
    [changelog](https://developers.cloudflare.com/workers-ai/changelog/))
  - Independent evidence on its tool-calling reliability is thin (mostly Cloudflare's own material,
    plus forum reports of model outages), so A0 tests it on our own questions.

## 1. Core idea

The model never touches the database. It can only call a small set of typed **tools**, which
are ordinary Minty API functions running the same parameterized queries as the dashboard. Tools
run as the signed-in person, so the agent can't do anything that person couldn't already do by
hand. Results stay on the server as **result sets**: the model sees a count, totals and a few
sample rows, and the page shows the full table.

Two ways to use it, sharing the same tools and limits:
- **Ask:** the chat panel, step by step (§2).
- **Automations:** work Minty does on its own after each hourly sync or on a schedule, with the
  results in the **dashboard inbox** (§4.1).

The agent can never move money: Minty only has Plaid's read-only Transactions product.

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

**Chosen (§10, revised):** four providers from the first release, with no OpenRouter
involvement for the direct ones:
- `openrouter` (`OPENROUTER_API_KEY`): free models, $0 (50 requests/day);
- `workers-ai` (no key: Cloudflare's `AI` binding): $0 within 10,000 Neurons/day, and the data
  stays within Cloudflare;
- `openai` (`OPENAI_API_KEY`): OpenAI's API directly, paid per use;
- `anthropic` (`ANTHROPIC_API_KEY`): Anthropic's Messages API directly, paid per use.

`AGENT_PROVIDER` picks one and `AGENT_MODEL` the model. Direct keys are paid per use, so the daily
caps always apply.

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
| `create_automation` ✱ | name, trigger, filter, action(s), optional AI instruction (§4.1) | a preview: what it would do, and how many current transactions match; saved after **Confirm** |
| `list_automations` | none | the person's automations, with their last run |
| `pause_automation` / `delete_automation` ✱ | id | a preview; applied after **Confirm** |

✱ = changes something, so it needs the person's Confirm.

Deliberately absent: raw SQL, linking banks, sync (the no-sync-endpoint rule stands), secrets,
deleting transactions or other data (removing an automation is the only delete, and it needs a
Confirm), and web browsing.

## 4.1 Automations and the inbox

Each automation is **when** (trigger) + **which transactions** (filter) + **what to do**
(action). People create them in the chat ("remind me when…"), where the agent drafts one and the
person confirms it, or from a form.

| When (trigger) | Which (filter) | What (action) |
|---|---|---|
| New transactions arrive (after each sync) | Exact filters, the same as `search_transactions`: bank/card, merchant, amount, category, pending, tags, dates | Add tags (add-only, labelled as added by the automation) |
| A watched pending transaction posts, including when its final amount differs | Optional **AI instruction** run on the filtered batch, e.g. "looks like a subscription price increase", "unusual for me" | An inbox note, linking to the transactions or a subset |
| A schedule: daily, weekly, monthly, or once on a date | | A summary: database totals, optionally written up by the model |
| | | An AI review: the model reads the matching batch and writes a note, or **suggests tags**, which wait in the inbox for a Confirm |

Examples beyond simple rules:
- "Tell me about any new recurring charge or subscription."
- "Each month, look for possible duplicate charges."
- "If a pending hotel or car-rental charge posts for more than it was authorised for, tell me."
- "Every Monday: last week's spending compared with my usual, in a few sentences."
- "Each Sunday, suggest tags for untagged transactions."

**How it runs on the free plan:**
- Automations run in the hourly cron, as a separate step after the sync.
- Exact filters and tagging are single SQL statements, with no per-row work (the same rule as the
  sync).
- AI work is rationed: at most `AUTOMATION_AI_RUNS_PER_DAY` model calls a day, counted in the same
  daily budget as the chat, and one per cron run. The rest wait for the next hour. A model call is
  mostly waiting, not CPU; A0 checks that one fits in a cron run (10 ms CPU, 50 subrequests).

**The inbox:**
- A bell with an unread count on the dashboard, opening a list of notes. Each note is plain text,
  with links to its transactions or a subset, and a Confirm button for suggested tags.
- Mark as read. Notes older than 90 days are removed.
- Notes go to the person who owns the automation (by their Access email).

**Rule change (needs approval in A3):** CLAUDE.md says sync never writes tags. That stays true:
automations run after the sync, as their own step. Tags they add are add-only and labelled with
their source; they never remove or overwrite a person's own tags. AI-suggested tags always need a
Confirm, unless the person turns on "apply automatically" for that automation.

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

## 6. Data model: the agent's migration

```
agent_conversations (id, email, title, model, created_at, updated_at)
agent_messages      (id, conversation_id, seq, role, content_json, tool_name, tokens_in, tokens_out, created_at)
agent_result_sets   (id, conversation_id, email, filter_json, row_count, created_at, expires_at)
agent_result_items  (result_set_id, transaction_id)         -- a snapshot of the matching rows, not a live filter
agent_usage         (day, email, tokens_in, tokens_out, cost_estimate_cents)
llm_credentials     (email, provider, key_enc, created_at)  -- only with option B
```

For automations and the inbox (A3–A4, a later migration):

```
automations         (id, email, name, enabled, trigger_json, filter_json, action_json, ai_instruction,
                     auto_apply, created_by, created_at, last_run_at, last_result)
automation_runs     (id, automation_id, started_at, matched, tagged, ai_calls, status)
inbox_items         (id, email, kind, title, body, links_json, created_at, read_at)
transaction_tags    + source TEXT NOT NULL DEFAULT 'user'   -- or 'automation:<id>'; existing rows stay 'user'
```

New settings, all off unless set:
- `AGENT_ENABLED` — the whole agent is off by default.
- `AGENT_PROVIDER` — which service to use.
- `AGENT_MODEL` — which model.
- `AGENT_MAX_STEPS` — steps per question, default 8.
- `AGENT_DAILY_TOKEN_BUDGET` — per person.
- `AUTOMATION_AI_RUNS_PER_DAY` — AI calls automations may make per day (default 10).
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
- **Automations never act silently on AI judgement:** AI-suggested tags wait for a Confirm unless
  the person opts in per automation; tags added by automations are labelled and can be removed;
  every run is logged (`automation_runs`) and shown with the automation.

## 8. Phases (each ends with a PR you review)

| Phase | What | Done when |
|---|---|---|
| **A0 Spikes** | See §8.1: pick a free model by testing tool calling on synthetic data, check it works with training disallowed, and estimate CPU per step | Results recorded in this doc |
| **A1 Query layer, no AI** | Extend `/transactions` (already filters by banks and cards since #18/#19) with amount range, category and pending; add totals by group, merchant matching, result sets, `/?set=` in the dashboard and CSV export. Useful even with the agent off | Tests pass with a real local D1 |
| **A2 Agent with tagging** | All adapters from the start (OpenAI-compatible for OpenRouter and OpenAI; Anthropic Messages; the Workers AI binding), `/agent/step`, chat panel, budgets, Setup checks, and `tag_transactions` with preview + **Confirm** (decision 3). Tests with a **fake model** for each adapter's wire format, like the fake Plaid used today | The example works end to end on test data with each provider, and tagging needs a confirm |
| **A3 Inbox + automations (no AI yet)** | The dashboard inbox; automations with triggers (new transactions, pending posts, schedules), exact filters, and actions (add tags, inbox notes, database summaries); a form, plus `create_automation` / `list_automations` / pause / delete in the agent. Needs the tag-source rule change (§4.1) | A watched pending charge posting produces an inbox note; a tagging automation tags new transactions; all tested on local D1 |
| **A4 AI-powered automations** | AI instructions as conditions, AI reviews and write-ups, suggested tags with Confirm, the daily AI budget for automations | The examples in §4.1 work on test data within the free limits |
| **A5 "Sign in with ChatGPT"** | Only if OpenAI opens it beyond its partner preview, and it works for self-hosted apps: use a Plus/Pro plan under its per-app cap | Separate go-ahead |
| **A6 Per-person sign-in** | Deferred: decision 1 chose a household secret | — |
| **A7 Optional** | Streamed replies, AI Gateway, and an MCP server offering the same tools to Claude Desktop and similar apps | Separate go-aheads |

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
   - Also **Workers AI** (through Cloudflare's REST API, with an account ID and an API token
     limited to Workers AI, also in `.dev.vars`), on 1–2 of its tool-calling models, reporting
     Neurons used.
   - And **direct OpenAI / Anthropic keys** if the owner adds them: a few requests each.
   - One **automation-style test**: give the model a batch of ~30 synthetic new transactions and
     ask for a short note plus suggested tags, to size the tokens/Neurons an AI review costs.
3. **CPU estimate:** time the Worker-side part of one step (build the prompt, parse a model reply,
   run a tool on local D1) in workerd with canned replies. Confirm on the live Worker's Metrics
   after A2, with the agent switched on only there.
4. Record the chosen default provider and model (for chat and for automations, which may
   differ), the numbers and any design changes here.

**Rule updates (need approval, applied in A2):** CLAUDE.md gains the agent rules: tools are the
only way the model reaches data, no model-written SQL, writes need confirmation, and whichever
key-storage option is chosen.

## 9. Decisions (made 2026-10-06; see §10)

1. **Keys:** A, one household secret.
2. **Provider (revised):** OpenRouter (free models), OpenAI and Anthropic, all from the first
   release; the direct ones need no OpenRouter account. No subscription bridges.
3. **Writes:** tagging with preview + Confirm from the first agent release (A2).
4. **Plan:** free Workers plan only. If steps don't fit, redesign rather than upgrade.
5. **Notifications:** the dashboard inbox.
6. **Scope:** Ask plus automations, which can use exact rules or AI judgement, strictly on the
   household's own data.

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
- **2026-10-06 (revised, owner): direct OpenAI and Anthropic keys from the start**, with no
  OpenRouter involvement, alongside OpenRouter's free models. A2 therefore ships both adapters;
  the old A3 (Anthropic adapter) is folded into A2.
  - **Subscription bridges are not supported** (CLIProxyAPI, codex-lb and similar, which reuse a
    Codex or Claude Code subscription login and expose it as an API, sometimes spreading load
    across several accounts):
    - Anthropic's terms prohibit subscription logins in third-party tools. Using a ChatGPT
      consumer session this way, or pooling accounts, is against OpenAI's terms. Both risk the
      account being suspended.
    - They're a separate always-on server holding the subscription login. The Worker can't reach
      one on a home PC, so it would have to be exposed to the internet, against Minty's no-server,
      no-public-endpoint goals.
    - They depend on internal interfaces that change without notice.
    - The household's financial data would pass through extra software.
  - **Watch:** OpenAI's official "Sign in with ChatGPT" is the legitimate route to subscription
    usage. Revisit (now A5) if it opens to apps like Minty.
- **2026-10-06 (owner): automations and a dashboard inbox.**
  - Beyond chat, Minty does background work after each sync or on a schedule, with results in a
    **dashboard inbox** (chosen over email or a push app). Reminders and rules were examples:
    automations can use exact rules or **AI judgement**, still strictly on the household's own
    data (§4.1).
  - Phases: A3 is the inbox and non-AI automations; A4 is AI-powered automations. The later
    phases are renumbered (Sign in with ChatGPT is now A5).
  - **Workers AI is added as a fourth provider** (no key; free 10,000 Neurons/day, blocked rather
    than billed when used up) and is tested in A0 alongside OpenRouter's free models.
  - Needs approval in A3: automations may add tags (add-only, labelled), as a separate step after
    the sync, which itself still never writes tags.
