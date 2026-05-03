/**
 * Rate limiting (Standard 12).
 *
 * Two tiers in v1:
 *   - `defaultLimiter`  — applied to every route. Generous; the local-first
 *     desktop app is the typical caller and shouldn't hit it.
 *   - `adminLimiter`    — tight cap on the GDPR data-export / data-erasure
 *     routes because they are expensive and destructive.
 *
 * Auth routes (Task #4) and LLM-bound routes (Task #5) will add their own
 * limiters when they ship.
 */
import rateLimit from "express-rate-limit";

import { err } from "../lib/api-envelope";

export const defaultLimiter = rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json(err("RATE_LIMITED", "Too many requests"));
  },
});

export const adminLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  // The in-memory test-runner bursts dozens of admin calls per second
  // against a single Express instance — that would trip the 5-rpm cap on
  // the very first GDPR/backup test and drown the rest of the suite in
  // 429s. The limiter still applies to every non-test execution path
  // (`NODE_ENV` is `development` or `production` everywhere else).
  skip: () => process.env["NODE_ENV"] === "test",
  handler: (_req, res) => {
    res
      .status(429)
      .json(
        err(
          "RATE_LIMITED",
          "Too many admin requests — try again in a minute",
        ),
      );
  },
});
