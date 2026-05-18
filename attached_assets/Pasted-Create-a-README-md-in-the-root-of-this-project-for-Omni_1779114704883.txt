Create a README.md in the root of this project for Omninity Operator. 

This README will be the public face of the repo at github.com/spartanceo/operator and will be read by senior engineers and AI researchers at companies like Anthropic, OpenAI, frontier AI labs, and AI infrastructure startups. The goal is to make the project's value and technical sophistication immediately clear within 30 seconds of opening the page.

PRODUCT DESCRIPTION:
Omninity Operator is a local-first AI desktop app that lets you run a personal AI agent entirely on your own machine — no data leaves your device. It connects to locally running models via Ollama to handle chat, web search, image generation, voice, and multi-step task automation, all with an approval-based safety layer so the user stays in control of what the agent does. The Desktop Control feature lets the agent see the user's screen and interact with apps using a Look–Act–Verify cycle (clicking, typing, and reading results) — without ever relying on cloud AI. Everything is stored locally with a full audit trail. It is the local-first companion to Omninity (https://omninity.ai), a hosted AI Business OS operable across Claude, ChatGPT and WhatsApp.

REQUIREMENTS FOR THE README:

1. Open with a clear one-line tagline.
2. Add a short paragraph summarising what it does and the three core principles: local-first, approval-gated, fully auditable.
3. Include a "What it does" section with bullets for: chat with local LLMs via Ollama, web search, image generation, voice (STT/TTS), multi-step task automation, Desktop Control with Look–Act–Verify, full local audit trail.
4. Include a "Why local-first" section explaining the three reasons: privacy, cost, latency/availability.
5. Include a "The Look–Act–Verify loop" section explaining the three steps (Look → Act → Verify) and why this is safer than feed-forward agents.
6. Include an "Approval-based safety layer" section explaining the configurable policy levels (always ask, trusted-action allowlist, class-based policy) and how it ties to the local audit log.
7. Include an "Architecture" section with a simple text/ASCII diagram showing: Conversation Layer, Desktop Control, Task Automation, Approval Gate, Audit Log, Ollama runtime. Use code-block forma