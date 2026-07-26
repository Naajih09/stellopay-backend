import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import express from "express";
import { billingRouter } from "./billing.js";

// Mock env and db
vi.mock("../config.js", () => ({ env: { BILLING_ENABLED: true } }));
// ... (Add your standard DB and schema mocks here)

describe("Billing Math Hardening", () => {
  it("should return progressPercentage 0 if limit is 0 (Prevent Div by Zero)", async () => {
    // Mock DB to return limit "0" and used "100"
    const res = await request(app).get("/api/v1/billing/profiles/prof_1/summary");
    expect(res.body.data.progressPercentage).toBe(0);
    expect(res.body.data.remainingAmount).toBe(0);
  });

  it("should cap progressPercentage at 100 if used exceeds limit", async () => {
    // Mock DB to return limit "100" and used "150"
    const res = await request(app).get("/api/v1/billing/profiles/prof_1/summary");
    expect(res.body.data.progressPercentage).toBe(100);
    expect(res.body.data.remainingAmount).toBe(0);
  });

  it("should reject malformed profileId containing special characters", async () => {
    const res = await request(app).get("/api/v1/billing/profiles/id;DROP TABLE/summary");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("alphanumeric");
  });

  it("should return 501 if BILLING_ENABLED is false", async () => {
    vi.mock("../config.js", () => ({ env: { BILLING_ENABLED: false } }));
    const res = await request(app).get("/api/v1/billing/profiles/prof_1/summary");
    expect(res.status).toBe(501);
  });
});