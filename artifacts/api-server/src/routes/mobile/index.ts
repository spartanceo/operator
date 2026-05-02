/**
 * /api/mobile — Mobile Companion PWA: pairing, devices, push, dashboard.
 */
import { Router, type IRouter } from "express";

import devicesRouter from "./devices";
import pairingRouter from "./pairing";
import dashboardRouter from "./dashboard";
import notificationsRouter from "./notifications";

const router: IRouter = Router();

router.use("/pairing", pairingRouter);
router.use("/devices", devicesRouter);
router.use("/notifications", notificationsRouter);
router.use("/", dashboardRouter);

export default router;
