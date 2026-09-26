// /api/health when the database misbehaves after boot (a Turso outage): the procedure must answer
// 503 with a "degraded" body, and must not hang on a query that never returns. The database module
// is mocked; the happy path is covered by the e2e run and the CI curl checks.
//
// Run with `bun test` (after `bun install`).

import { test, expect, mock } from "bun:test";
import { call, ORPCError } from "@orpc/server";

const failing = { execute: () => Promise.reject(new Error("connection refused")), batch: () => Promise.reject(new Error("connection refused")) };
const hanging = { execute: () => new Promise(() => {}), batch: () => new Promise(() => {}) };
const helpers = {
  str: (r: Record<string, unknown>, c: string) => (r[c] == null ? null : String(r[c])),
  num: (r: Record<string, unknown>, c: string) => Number(r[c] ?? 0),
  blob: () => null,
  migrate: async () => {},
};

mock.module("../server/db", () => ({ db: failing, ...helpers }));
const { router } = await import("../server/router");

test("health answers 503 with a degraded body when the database fails", async () => {
  let caught: unknown;
  try {
    await call(router.health, undefined, { context: {} });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ORPCError);
  const err = caught as ORPCError<string, { status: string; db: string; storage: string }>;
  expect(err.status).toBe(503);
  expect(err.message).toContain("connection refused");
  expect(err.data.status).toBe("degraded");
  expect(err.data.db).toContain("connection refused");
  expect(err.data.storage).toBe("database");
});

test("the probe times out instead of hanging", async () => {
  mock.module("../server/db", () => ({ db: hanging, ...helpers }));
  const started = Date.now();
  await expect(call(router.health, undefined, { context: {} })).rejects.toMatchObject({ status: 503, message: expect.stringContaining("no answer in") });
  expect(Date.now() - started).toBeLessThan(4500);
}, 10_000);
