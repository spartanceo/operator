/**
 * /api/referrals — referral codes, dashboard, attribution, rewards,
 * acquisition-channel survey, enterprise-trial invites, beta access.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  attributeReferral,
  completeReferralForReferred,
  createEnterpriseTrialInvite,
  getAcquisitionChannel,
  getBetaAccess,
  getDashboard,
  getOrCreateReferralCode,
  listActiveRewards,
  listEnterpriseTrialInvites,
  ReferralNotFoundError,
  ReferralValidationError,
  resolveReferralCode,
  setAcquisitionChannel,
} from "../../services/referrals.service";

const router: IRouter = Router();

const AttributeSchema = z.object({
  code: z.string().min(1).max(120),
  email: z.string().email().max(200).optional(),
  label: z.string().min(1).max(120).optional(),
});

const ChannelSchema = z.object({
  channel: z.enum([
    "search",
    "social",
    "friend",
    "creator",
    "podcast",
    "blog",
    "work",
    "other",
  ]),
  detail: z.string().max(400).optional(),
});

const EnterpriseInviteSchema = z.object({
  colleagueEmail: z.string().email().max(200),
  colleagueName: z.string().min(1).max(120).optional(),
  company: z.string().min(1).max(200).optional(),
  note: z.string().max(2_000).optional(),
});

router.get("/code", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const code = await getOrCreateReferralCode(ctx);
    res.json(ok({ code }));
  } catch (e) {
    next(e);
  }
});

router.get("/dashboard", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const dashboard = await getDashboard(ctx);
    res.json(ok({ dashboard }));
  } catch (e) {
    next(e);
  }
});

router.get("/rewards", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const rewards = await listActiveRewards(ctx);
    res.json(ok({ rewards }));
  } catch (e) {
    next(e);
  }
});

router.get("/beta-access", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const access = await getBetaAccess(ctx);
    res.json(ok({ access }));
  } catch (e) {
    next(e);
  }
});

router.post("/attribute", requireTenant(), async (req, res, next) => {
  try {
    const parsed = AttributeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid attribution payload"));
      return;
    }
    const ctx = requireTenantContext();
    const referral = await attributeReferral(ctx, parsed.data);
    res.json(ok({ referral }));
  } catch (e) {
    if (e instanceof ReferralNotFoundError) {
      res.status(404).json(err(e.code, e.message));
      return;
    }
    if (e instanceof ReferralValidationError) {
      res.status(400).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

router.post("/complete", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const result = await completeReferralForReferred(ctx);
    res.json(ok({ result }));
  } catch (e) {
    next(e);
  }
});

router.get("/lookup/:code", async (req, res, next) => {
  try {
    const code = String(req.params["code"] ?? "").trim();
    if (!code) {
      res.status(400).json(err("VALIDATION", "code required"));
      return;
    }
    const resolved = await resolveReferralCode(code);
    res.json(ok({ valid: resolved !== null, code }));
  } catch (e) {
    next(e);
  }
});

router.get("/acquisition", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const channel = await getAcquisitionChannel(ctx);
    res.json(ok({ channel }));
  } catch (e) {
    next(e);
  }
});

router.put("/acquisition", requireTenant(), async (req, res, next) => {
  try {
    const parsed = ChannelSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid channel payload"));
      return;
    }
    const ctx = requireTenantContext();
    const channel = await setAcquisitionChannel(ctx, parsed.data);
    res.json(ok({ channel }));
  } catch (e) {
    next(e);
  }
});

router.post("/enterprise-trial", requireTenant(), async (req, res, next) => {
  try {
    const parsed = EnterpriseInviteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid enterprise invite"));
      return;
    }
    const ctx = requireTenantContext();
    const invite = await createEnterpriseTrialInvite(ctx, parsed.data);
    res.json(ok({ invite }));
  } catch (e) {
    if (e instanceof ReferralValidationError) {
      res.status(400).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

router.get("/enterprise-trial", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const invites = await listEnterpriseTrialInvites(ctx);
    res.json(ok({ invites }));
  } catch (e) {
    next(e);
  }
});

export default router;
