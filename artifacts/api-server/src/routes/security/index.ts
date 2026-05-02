/**
 * /api/security — barrel router for the security stack.
 *
 * Each sub-router mounts its own paths and Express composes them as a
 * flat namespace. Order is irrelevant; the path matching does the work.
 */
import { Router, type IRouter } from "express";

import admin2faRouter from "./admin-2fa";
import auditRouter from "./audit";
import autoLockRouter from "./auto-lock";
import eventsRouter from "./events";
import jwtRouter from "./jwt";
import masterPasswordRouter from "./master-password";
import nukeRouter from "./nuke";
import reportRouter from "./report";
import scanSkillRouter from "./scan-skill";
import telemetryRouter from "./telemetry";
import webhookSecretsRouter from "./webhook-secrets";

const router: IRouter = Router();

router.use("/", auditRouter);
router.use("/", eventsRouter);
router.use("/", reportRouter);
router.use("/", masterPasswordRouter);
router.use("/", autoLockRouter);
router.use("/", telemetryRouter);
router.use("/", scanSkillRouter);
router.use("/", webhookSecretsRouter);
router.use("/", admin2faRouter);
router.use("/", jwtRouter);
router.use("/", nukeRouter);

export default router;
