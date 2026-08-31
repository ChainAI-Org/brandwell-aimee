import { z } from "zod";

export const ProductionReadinessCheckSchema = z
  .object({
    status: z.enum(["pass", "fail"]),
    code: z.string().regex(/^[a-z][a-z0-9_]*$/),
  })
  .strict();

export const ProductionReadinessSchema = z
  .object({
    ok: z.boolean(),
    service: z.literal("aimee"),
    revision: z.string().nullable(),
    checkedAt: z.iso.datetime(),
    checks: z
      .object({
        deploymentRevision: ProductionReadinessCheckSchema,
        database: ProductionReadinessCheckSchema,
        migrations: ProductionReadinessCheckSchema,
        worker: ProductionReadinessCheckSchema,
        managedAdmin: ProductionReadinessCheckSchema,
        openRouterManagement: ProductionReadinessCheckSchema,
        runtimeInference: ProductionReadinessCheckSchema,
        computer: ProductionReadinessCheckSchema,
        brandwellBridge: ProductionReadinessCheckSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const allChecksPass = Object.values(value.checks).every((check) => check.status === "pass");
    if (value.ok !== allChecksPass) {
      context.addIssue({
        code: "custom",
        path: ["ok"],
        message: "Readiness must match the aggregate check status",
      });
    }
  });

export type ProductionReadiness = z.infer<typeof ProductionReadinessSchema>;
export type ProductionReadinessCheck = z.infer<typeof ProductionReadinessCheckSchema>;
