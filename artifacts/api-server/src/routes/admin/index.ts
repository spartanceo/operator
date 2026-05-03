/**
 * Admin route barrel — mounted at `/api/admin`.
 *
 * Each sub-route attaches its own path. We register them with explicit
 * `Router.use("/", subRouter)` rather than the bare `Router.use(subRouter)`
 * form because the latter does not always mount in nested-router setups
 * (Express 5 retained the strict matching behaviour).
 */
import { Router, type IRouter } from "express";

import enterpriseRouter from "./enterprise";
import superRouter from "./super";
import tenantDataRouter from "./tenant-data";

const router: IRouter = Router();

router.use("/", tenantDataRouter);
router.use("/", superRouter);
router.use("/", enterpriseRouter);

export default router;
