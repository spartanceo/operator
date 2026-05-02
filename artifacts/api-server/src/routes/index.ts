/**
 * Top-level /api router. Mounts every domain sub-router. Order is purely
 * cosmetic — Express matches by path, not order.
 */
import { Router, type IRouter } from "express";

import adminRouter from "./admin";
import agentRouter from "./agent";
import authRouter from "./auth";
import browserRouter from "./browser";
import chatRouter from "./chat";
import filesRouter from "./files";
import healthRouter from "./health";
import memoryRouter from "./memory";
import modelsRouter from "./models";
import privacyRouter from "./privacy";
import toolsRouter from "./tools";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/admin", adminRouter);
router.use("/auth", authRouter);
router.use("/models", modelsRouter);
router.use("/chat", chatRouter);
router.use("/agent", agentRouter);
router.use("/tools", toolsRouter);
router.use("/privacy", privacyRouter);
router.use("/memory", memoryRouter);
router.use("/files", filesRouter);
router.use("/browser", browserRouter);

export default router;
