import { z } from "zod";
import { isoDateSchema, successEnvelope } from "./common.js";
import { classSchema } from "./knowledge.js";
import { notificationSchema } from "./collaboration.js";
import { outcomeSchema, taskSchema } from "./work.js";

export const dashboardReadModelSchema = z.object({
  tasks: z.array(taskSchema),
  reviews: z.array(taskSchema),
  blockers: z.array(taskSchema),
  classes: z.array(classSchema),
  outcomes: z.array(outcomeSchema),
  mentions: z.array(notificationSchema),
  asOf: isoDateSchema,
});

export const dashboardResponseSchema = successEnvelope(dashboardReadModelSchema);
