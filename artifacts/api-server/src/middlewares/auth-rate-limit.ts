/**
 * Auth + sensitive-route rate limiters.
 *
 * Standard 12 § "Rate limit by tier": authentication endpoints
 * (login, register, master-password verify, refresh-token rotation)
 * cap at 30 / minute per IP. LLM-bound routes cap at 60 / minute.
 * Inbound webhook routes cap at 120 / minute (high enough for
 * legitimate event bursts; low enough that a flood is throttled).
 *
 * Each limiter ships a 429 envelope using the canonical `err()`
 * helper so clients can match on the same `code` regardless of which
 * gate fired.
 */
import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";

import { err } from "../lib/api-envelope";

export const authLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: (_req, res) => {
    res
      .status(429)
      .json(err("RATE_LIMITED_AUTH", "Too many authentication attempts — wait a minute"));
  },
});

export const llmLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: (_req, res) => {
    res
      .status(429)
      .json(err("RATE_LIMITED_LLM", "Too many model requests — wait a minute"));
  },
});

export const webhookLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: (_req, res) => {
    res
      .status(429)
      .json(err("RATE_LIMITED_WEBHOOK", "Too many webhook calls — wait a minute"));
  },
});
