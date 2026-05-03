/**
 * Top-level /api router. Mounts every domain sub-router. Order is purely
 * cosmetic — Express matches by path, not order.
 */
import { Router, type IRouter } from "express";

import activityRouter from "./activity";
import adminRouter from "./admin";
import agentRouter from "./agent";
import authRouter from "./auth";
import browserRouter from "./browser";
import chatRouter from "./chat";
import commRouter from "./comm";
import conversationsRouter from "./conversations";
import desktopRouter from "./desktop";
import diagnosticsRouter from "./diagnostics";
import distributionRouter from "./distribution";
import eventsRouter from "./events";
import filesRouter from "./files";
import healthRouter from "./health";
import integrationsRouter from "./integrations";
import knowledgeRouter from "./knowledge";
import legalRouter from "./legal";
import mediaRouter from "./media";
import memoryRouter from "./memory";
import mobileRouter from "./mobile";
import modelsRouter from "./models";
import notificationsRouter from "./notifications";
import onboardingRouter from "./onboarding";
import p2pRouter from "./p2p";
import pluginsRouter from "./plugins";
import privacyRouter from "./privacy";
import schedulesRouter from "./schedules";
import securityRouter from "./security";
import skillsRouter from "./skills";

import tasksRouter from "./tasks";
import taskTemplatesRouter from "./task-templates";

import storeRouter from "./store";
import subscriptionRouter from "./subscription";
import creatorRevenueRouter from "./creator-revenue";
import systemIntegrationRouter from "./system-integration";

import telemetryRouter from "./telemetry";
import toolsRouter from "./tools";
import undoRouter from "./undo";
import updatesRouter from "./updates";
import webhooksRouter from "./webhooks";
import workspacesRouter from "./workspaces";
import referralsRouter from "./referrals";
import shareRouter from "./share";
import creatorProfilesRouter from "./creator-profiles";
import waitlistRouter from "./waitlist";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/admin", adminRouter);
router.use("/auth", authRouter);
router.use("/models", modelsRouter);
router.use("/chat", chatRouter);
router.use("/conversations", conversationsRouter);
router.use("/agent", agentRouter);
router.use("/tools", toolsRouter);
router.use("/privacy", privacyRouter);
router.use("/security", securityRouter);
router.use("/memory", memoryRouter);
router.use("/knowledge", knowledgeRouter);
router.use("/legal", legalRouter);
router.use("/files", filesRouter);
router.use("/browser", browserRouter);
router.use("/onboarding", onboardingRouter);
router.use("/integrations", integrationsRouter);
router.use("/updates", updatesRouter);
router.use("/desktop", desktopRouter);
router.use("/diagnostics", diagnosticsRouter);
router.use("/distribution", distributionRouter);
router.use("/p2p", p2pRouter);
router.use("/media", mediaRouter);
router.use("/comm", commRouter);
router.use("/notifications", notificationsRouter);
router.use("/activity", activityRouter);
router.use("/mobile", mobileRouter);
router.use("/telemetry", telemetryRouter);
router.use("/undo", undoRouter);
router.use("/workspaces", workspacesRouter);
router.use("/skills", skillsRouter);

router.use("/tasks", tasksRouter);
router.use("/task-templates", taskTemplatesRouter);
router.use("/schedules", schedulesRouter);
router.use("/referrals", referralsRouter);
router.use("/share", shareRouter);
router.use("/creators", creatorProfilesRouter);
router.use("/waitlist", waitlistRouter);

router.use("/store", storeRouter);
router.use("/subscription", subscriptionRouter);
router.use("/creator", creatorRevenueRouter);
router.use("/system-integration", systemIntegrationRouter);

router.use("/plugins", pluginsRouter);
router.use("/webhooks", webhooksRouter);
router.use("/events", eventsRouter);

export default router;
