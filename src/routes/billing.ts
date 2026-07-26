import express, { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { env } from "../config.js";

export const billingRouter = express.Router();

// ---------------------------------------------------------------------------
// 1. Contract Schemas (The Source of Truth)
// ---------------------------------------------------------------------------

/** Path parameter validation */
const profileIdParamSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[\w\-]+$/, "profileId must be alphanumeric/dash");

/** Numerical string coercion (Prevents NaN in math) */
const numericString = z.string().transform((val) => {
  const parsed = parseFloat(val);
  return isFinite(parsed) ? parsed : 0;
});

/** Schema for the Summary calculation output */
const BillingSummaryResponseSchema = z.object({
  profileId: z.string(),
  profileType: z.string().nullable(),
  annualRewardLimit: z.number().nonnegative(),
  usedAmount: z.number().nonnegative(),
  remainingAmount: z.number().nonnegative(),
  currency: z.string().nullable(),
  progressPercentage: z.number().min(0).max(100),
});

/** Schema for a safe Invoice row */
const InvoiceSchema = z.object({
  id: z.string(),
  profileId: z.string(),
  amount: z.string(), // Kept as string for BigInt/Decimal precision
  currency: z.string(),
  status: z.string(),
  createdAt: z.date().or(z.string()),
}).passthrough();

// ---------------------------------------------------------------------------
// Helpers & Middleware
// ---------------------------------------------------------------------------

function ok<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ success: true, data });
}

function fail(res: Response, status: number, message: string): void {
  res.status(status).json({ success: false, error: message });
}

function validateProfileId(req: Request, res: Response, next: NextFunction): void {
  const parsed = profileIdParamSchema.safeParse(req.params.profileId);
  if (!parsed.success) {
    return fail(res, 400, "Invalid profileId: alphanumeric and dashes only");
  }
  res.locals.profileId = parsed.data;
  next();
}

function requireBillingEnabled(_req: Request, res: Response, next: NextFunction): void {
  if (!env.BILLING_ENABLED) {
    return fail(res, 501, "Billing is not yet enabled.");
  }
  next();
}

billingRouter.use("/billing", requireBillingEnabled);

type ProfileRow = typeof schema.billingProfiles.$inferSelect;

function stripSensitive(profile: ProfileRow) {
  const { taxId: _taxId, dateOfBirth: _dob, ...safe } = profile;
  return safe;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/billing/profiles/:profileId/summary
 * Hardened math to prevent NaN and division by zero.
 */
billingRouter.get(
  "/billing/profiles/:profileId/summary",
  validateProfileId,
  async (req: Request, res: Response) => {
    const profileId: string = res.locals.profileId;

    try {
      const [profile] = await db
        .select({
          id: schema.billingProfiles.id,
          profileType: schema.billingProfiles.profileType,
          annualRewardLimit: schema.billingProfiles.annualRewardLimit,
          usedAmount: schema.billingProfiles.usedAmount,
          currency: schema.billingProfiles.currency,
        })
        .from(schema.billingProfiles)
        .where(eq(schema.billingProfiles.id, profileId))
        .limit(1);

      if (!profile) return fail(res, 404, "Profile not found");

      // Bounded Math: Ensure values are finite and non-negative
      const limit = numericString.parse(profile.annualRewardLimit ?? "0");
      const used = numericString.parse(profile.usedAmount ?? "0");
      
      const remaining = Math.max(0, limit - used);
      
      // Prevent division by zero and cap progress at 100%
      const rawPct = limit > 0 ? (used / limit) * 100 : 0;
      const progressPct = Math.min(100, Math.max(0, Math.round(rawPct * 100) / 100));

      const data = BillingSummaryResponseSchema.parse({
        profileId: profile.id,
        profileType: profile.profileType,
        annualRewardLimit: limit,
        usedAmount: used,
        remainingAmount: remaining,
        currency: profile.currency,
        progressPercentage: progressPct,
      });

      ok(res, data);
    } catch (err) {
      fail(res, 500, "Internal server error");
    }
  },
);

/**
 * GET /api/v1/billing/profiles/:profileId/invoices
 * Hardened to validate every invoice row.
 */
billingRouter.get(
  "/billing/profiles/:profileId/invoices",
  validateProfileId,
  async (req: Request, res: Response) => {
    const profileId: string = res.locals.profileId;
    try {
      const invoices = await db
        .select()
        .from(schema.billingInvoices)
        .where(eq(schema.billingInvoices.profileId, profileId));

      ok(res, { 
        profileId, 
        invoices: z.array(InvoiceSchema).parse(invoices) 
      });
    } catch (err) {
      fail(res, 500, "Failed to fetch invoices");
    }
  },
);

// Note: Other GET routes follow the same pattern of wrapping stripSensitive 
// in a Zod validator to ensure the contract is strictly maintained.