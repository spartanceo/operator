/**
 * JWT bearer-token middleware for admin-tier routes.
 *
 * Extracts the `Authorization: Bearer <token>` header, verifies the
 * signature + expiry through `jwt.service`, and stamps the resolved
 * claims onto `res.locals.jwt` so downstream handlers can inspect the
 * actor without re-parsing.
 */
import type { NextFunction, Request, Response } from "express";

import { err } from "../lib/api-envelope";
import { JwtError, verifyJwt } from "../services/jwt.service";

export function jwtAuth(requiredRole?: string) {
  return function jwtAuthMiddleware(req: Request, res: Response, next: NextFunction) {
    const header = req.header("authorization");
    if (!header || !header.toLowerCase().startsWith("bearer ")) {
      res.status(401).json(err("MISSING_TOKEN", "Authorization bearer token required"));
      return;
    }
    const token = header.slice(7).trim();
    try {
      const claims = verifyJwt(token);
      if (requiredRole && claims.role !== requiredRole) {
        res.status(403).json(err("FORBIDDEN", `Role ${requiredRole} required`));
        return;
      }
      res.locals["jwt"] = claims;
      next();
    } catch (e) {
      if (e instanceof JwtError) {
        res.status(e.status).json(err(e.code, e.message));
        return;
      }
      next(e);
    }
  };
}
