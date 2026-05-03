/**
 * Top-level /api router. Mounts every domain sub-router. Order is purely
 * cosmetic — Express matches by path, not order.
 */
import { Router, type IRouter } from "express";

import activityRouter from "./activity";
import adminRouter from "./admin";
import agentRouter from "./agent";
import authRouter from "./auth";
import backupRouter from "./backup";
import browserRouter from "./browser";
import chatRouter from "./chat";
import commRouter from "./comm";
import conversationsRouter from "./conversations";
import desktopRouter from "./desktop";
import diagnosticsRouter from "./diagnostics";
import distributionRouter from "./distribution";
import drRouter from "./dr";
import eventsRouter from "./events";
import exportRouter from "./export";
import filesRouter from "./files";
import healthRouter from "./health";
import integrationsRouter from "./integrations";
import knowledgeRouter from "./knowledge";
import legalRouter from "./legal";
import mdmRouter from "./mdm";
import mediaRouter from "./media";
import memoryRouter from "./memory";
import mobileRouter from "./mobile";
import modelsRouter from "./models";
import notificationsRouter from "./notifications";
import onboardingRouter from "./onboarding";
import p2pRouter from "./p2p";
import pluginsRouter from "./plugins";
import privacyRouter from "./privacy";
import privacyResidencyRouter from "./privacy/residency";
import recoveryRouter from "./recovery";
import runtimesRouter from "./runtimes";
import schedulesRouter from "./schedules";
import securityRouter from "./security";
import skillsRouter from "./skills";

import tasksRouter from "./tasks";
import taskTemplatesRouter from "./task-templates";

import storeRouter from "./store";
import subscriptionRouter from "./subscription";
import creatorRevenueRouter from "./creator-revenue";
import systemIntegrationRouter from "./system-integration";
import creatorLegalRouter from "./creator-legal";

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
import supportRouter from "./support";
import feedbackRouter from "./feedback";
import statusPageRouter from "./status-page";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/admin", adminRouter);
router.use("/auth", authRouter);
router.use("/runtimes", runtimesRouter);
router.use("/models", modelsRouter);
router.use("/chat", chatRouter);
router.use("/conversations", conversationsRouter);
router.use("/agent", agentRouter);
router.use("/tools", toolsRouter);
router.use("/privacy", privacyRouter);
router.use("/privacy", privacyResidencyRouter);
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
router.use("/dr", drRouter);
router.use("/mdm", mdmRouter);
router.use("/p2p", p2pRouter);
router.use("/media", mediaRouter);
router.use("/comm", commRouter);
router.use("/notifications", notificationsRouter);
router.use("/activity", activityRouter);
router.use("/mobile", mobileRouter);
router.use("/telemetry", telemetryRouter);
router.use("/undo", undoRouter);
router.use("/recovery", recoveryRouter);
router.use("/workspaces", workspacesRouter);
router.use("/skills", skillsRouter);

router.use("/tasks", tasksRouter);
router.use("/task-templates", taskTemplatesRouter);
router.use("/schedules", schedulesRouter);
router.use("/referrals", referralsRouter);
router.use("/share", shareRouter);
router.use("/creators", creatorProfilesRouter);
router.use("/creator-legal", creatorLegalRouter);
router.use("/waitlist", waitlistRouter);
router.use("/support", supportRouter);
router.use("/feedback", feedbackRouter);
router.use("/status-page", statusPageRouter);

router.use("/store", storeRouter);
router.use("/subscription", subscriptionRouter);
router.use("/creator", creatorRevenueRouter);
router.use("/system-integration", systemIntegrationRouter);

router.use("/plugins", pluginsRouter);
router.use("/webhooks", webhooksRouter);
router.use("/events", eventsRouter);

router.use("/backup", backupRouter);
router.use("/export", exportRouter);

import ssoRouter from "./sso";
import scimRouter from "./scim";
router.use("/sso", ssoRouter);
router.use("/scim", scimRouter);

export default router;
