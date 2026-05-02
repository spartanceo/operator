/**
 * /api/comm — connected accounts, email, calendar, voip, outreach, contacts.
 */
import { Router, type IRouter } from "express";

import accountsRouter from "./accounts";
import calendarRouter from "./calendar";
import contactsRouter from "./contacts";
import emailRouter from "./email";
import outreachRouter from "./outreach";
import voipRouter from "./voip";

const router: IRouter = Router();

router.use("/accounts", accountsRouter);
router.use("/email", emailRouter);
router.use("/calendar", calendarRouter);
router.use("/voip", voipRouter);
router.use("/outreach", outreachRouter);
router.use("/contacts", contactsRouter);

export default router;
