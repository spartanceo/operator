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
import desktopRouter from "./desktop";
import distributionRouter from "./distribution";
import filesRouter from "./files";
import healthRouter from "./health";
import knowledgeRouter from "./knowledge";
import mediaRouter from "./media";
import memoryRouter from "./memory";
import mobileRouter from "./mobile";
import modelsRouter from "./models";
import notificationsRouter from "./notifications";
import onboardingRouter from "./onboarding";
import privacyRouter from "./privacy";
import securityRouter from "./security";
import telemetryRouter from "./telemetry";
import toolsRouter from "./tools";
import updatesRouter from "./updates";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/admin", adminRouter);
router.use("/auth", authRouter);
router.use("/models", modelsRouter);
router.use("/chat", chatRouter);
router.use("/agent", agentRouter);
router.use("/tools", toolsRouter);
router.use("/privacy", privacyRouter);
router.use("/security", securityRouter);
router.use("/memory", memoryRouter);
router.use("/knowledge", knowledgeRouter);
router.use("/files", filesRouter);
router.use("/browser", browserRouter);
router.use("/onboarding", onboardingRouter);
router.use("/updates", updatesRouter);
router.use("/desktop", desktopRouter);
router.use("/distribution", distributionRouter);
router.use("/media", mediaRouter);
router.use("/comm", commRouter);
router.use("/notifications", notificationsRouter);
router.use("/activity", activityRouter);
router.use("/mobile", mobileRouter);
router.use("/telemetry", telemetryRouter);

export default router;
