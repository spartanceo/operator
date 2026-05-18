# Omninity Operator

**A personal AI agent that runs entirely on your machine — no cloud, no subscriptions, no data leaving your device.**

Omninity Operator is a local-first desktop app (macOS, Electron) that connects to locally running language models via [Ollama](https://ollama.ai) to handle chat, web search, image generation, voice, and multi-step task automation. Every action passes through a configurable approval gate before it executes, and every decision is written to a tamper-evident local audit log. Three principles govern every design decision: **local-first**, **approval-gated**, **fully auditable**.

---

## What it does

- **Chat with local LLMs** — Connects directly to Ollama; switch between Llama 3, Mistral, Gemma 4, Qwen, Phi, and any other Ollama-compatible model from the model picker. No API key required.
- **Web search** — Agents issue structured search queries and synthesise results locally; raw results never touch a third-party summarisation service.
- **Image generation** — ComfyUI integration for fully local Stable Diffusion pipelines. The operator orchestrates prompt construction and retrieves generated assets without leaving the host.
- **Voice (STT / TTS)** — On-device speech-to-text via Whisper and text-to-speech via Piper. Wake-word detection and voice replies work entirely offline.
- **Multi-step task automation** — An approval-gated agent loop plans, executes, and verifies sequences of tool calls across search, file operations, browser actions, and API calls. Each step is individually approvable or delegatable.
- **Desktop Control with Look–Act–Verify** — The agent captures a semantic screenshot of the active display, identifies targets by description rather than pixel coordinates, performs the action, and verifies the resulting state before advancing. No coordinate hacks; no brittle selectors.
- **Full local audit trail** — Every tool invocation, approval decision, model call, and step outcome is persisted to a local SQLite database. The audit log is the single source of truth for rollback, replay, and compliance review.

---

## Why local-first

**Privacy.** Your conversations, tasks, documents, and screen captures never leave the device. There is no telemetry pipeline, no training opt-in, no vendor able to read your data — by construction, not by policy.

**Cost.** Running Llama 3.1 8B on a MacBook Pro M3 costs $0 per token. For high-volume agentic workloads (hundreds of tool calls per hour) this difference is not marginal — it is the difference between a viable product and an unaffordable one.

**Latency and availability.** Local inference has no network round-trip, no cold-start, and no API quota. Agents that depend on cloud inference are fragile to outages and rate limits; Operator runs identically whether your internet is fast, slow, or absent.

---

## The Look–Act–Verify loop

Most autonomous agents are feed-forward: they plan, execute, and hope. Operator's Desktop Control uses a three-phase cycle that catches errors before they compound:

```
┌─────────────────────────────────────────────────────────────────┐
│  LOOK     Capture a semantic screenshot of the current screen.  │
│           Identify the target element by natural-language        │
│           description — no coordinates, no brittle selectors.   │
├─────────────────────────────────────────────────────────────────┤
│  ACT      Execute the action (click, type, scroll, key chord).  │
│           The action is recorded in the audit log before it      │
│           fires. High-risk action classes pause for approval.    │
├─────────────────────────────────────────────────────────────────┤
│  VERIFY   Capture a new screenshot. Confirm the expected state   │
│           is present. If verification fails, the step is marked  │
│           failed and the agent surfaces the discrepancy rather   │
│           than silently continuing.                              │
└─────────────────────────────────────────────────────────────────┘
```

This is safer than feed-forward agents because errors are caught at the step boundary, not after an irreversible cascade. Each LAV cycle is an atomic unit in the audit log: look frame, action taken, verify frame, outcome.

---

## Approval-based safety layer

Every action an agent proposes passes through a configurable policy engine before execution. Three policy levels are available per action class:

| Level | Behaviour |
|---|---|
| **Always ask** | Every proposed action surfaces an approval modal before it runs. Default for irreversible operations (file deletion, sending email, form submission). |
| **Trusted-action allowlist** | Named actions on named targets (e.g. `browser.click` on `google.com`) execute automatically. All others pause for approval. |
| **Class-based policy** | Action classes (read, write, network, UI interaction) carry a default trust level set by the user. The agent operates within that envelope autonomously. |

Every approval decision — granted, denied, timed-out — is written to the audit log with the full action payload, the step context, and a timestamp. This makes the audit log a complete, human-readable record of what the agent did and what the user permitted, suitable for post-hoc review and compliance.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Omninity Operator                              │
│                                                                        │
│  ┌─────────────────┐   ┌──────────────────┐   ┌───────────────────┐  │
│  │ Conversation    │   │ Desktop Control   │   │ Task Automation   │  │
│  │ Layer           │   │ (LAV cycle)       │   │ (agent loop)      │  │
│  │                 │   │                   │   │                   │  │
│  │ • Chat          │   │ • Screen capture  │   │ • Multi-step plan │  │
│  │ • Web search    │   │ • Semantic target │   │ • Tool dispatch   │  │
│  │ • Image gen     │   │ • Action execute  │   │ • Step retry      │  │
│  │ • Voice STT/TTS │   │ • State verify    │   │ • Schedule        │  │
│  └────────┬────────┘   └────────┬──────────┘   └────────┬──────────┘  │
│           │                     │                        │              │
│           └─────────────────────┴────────────────────────┘              │
│                                 │                                        │
│                    ┌────────────▼────────────┐                          │
│                    │     Approval Gate        │                          │
│                    │  always-ask · allowlist  │                          │
│                    │  class-based policy      │                          │
│                    └────────────┬────────────┘                          │
│                                 │                                        │
│           ┌─────────────────────┴────────────────────────┐             │
│           │                                               │             │
│  ┌────────▼────────┐                          ┌──────────▼──────────┐  │
│  │   Audit Log      │                          │   Ollama Runtime     │  │
│  │  (local SQLite)  │                          │                      │  │
│  │                  │                          │  Llama 3 · Mistral   │  │
│  │ • Every action   │                          │  Gemma 4 · Qwen      │  │
│  │ • Every approval │                          │  Whisper · Piper     │  │
│  │ • Every outcome  │                          │  ComfyUI (image gen) │  │
│  └──────────────────┘                          └─────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

**Stack:** Electron (macOS shell) · React + Vite (operator UI) · Express (embedded API server) · Drizzle ORM + SQLite (local persistence) · Ollama (LLM / vision / embedding runtime) · Piper TTS · Whisper STT · ComfyUI (image generation) · pnpm monorepo.

---

## Requirements

- macOS 13 Ventura or later (Apple Silicon recommended)
- [Ollama](https://ollama.ai) installed and running locally
- Node.js 20+ and pnpm 8+
- At least one pulled model: `ollama pull llama3.1:8b`

```bash
git clone https://github.com/spartanceo/operator
cd operator
pnpm install
pnpm --filter @workspace/api-server run migrate
pnpm --filter @workspace/omninity-desktop run dev
```

---

## Relation to Omninity

Operator is the local-first companion to [Omninity](https://omninity.ai) — a hosted AI Business OS operable across Claude, ChatGPT, and WhatsApp. Operator shares the same task model, approval semantics, and audit schema, but everything runs on your hardware with no dependency on the Omninity cloud.

---

## Licence

Private repository. All rights reserved. Contact [spartanceo](https://github.com/spartanceo) for licensing enquiries.
