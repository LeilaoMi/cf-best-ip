import test from "node:test";
import assert from "node:assert/strict";
import { buildWantedIps, planDnsRecordSync } from "../src/dns.js";

test("buildWantedIps dedupes and respects topN", () => {
  const ips = [
    { ip: "104.16.0.1" },
    { ip: "104.16.0.1" },
    { ip: "104.16.0.2" },
    {},
    { ip: "104.16.0.3" },
  ];
  assert.deepEqual(buildWantedIps(ips, 2), ["104.16.0.1", "104.16.0.2"]);
});

test("planDnsRecordSync creates topN posts when no existing records", () => {
  const plan = planDnsRecordSync(
    "cf.example.com",
    [{ ip: "104.16.0.1" }, { ip: "104.16.0.2" }, { ip: "104.16.0.3" }],
    2,
    [],
  );
  assert.deepEqual(plan.deletes, []);
  assert.deepEqual(plan.ips, ["104.16.0.1", "104.16.0.2"]);
  assert.equal(plan.posts.length, 2);
  assert.equal(plan.posts[0].type, "A");
  assert.equal(plan.posts[0].proxied, false);
});

test("planDnsRecordSync supports AAAA records", () => {
  const plan = planDnsRecordSync(
    "cf.example.com",
    [{ ip: "2606:4700::1" }, { ip: "2606:4700::2" }],
    2,
    [],
    0.3,
    "AAAA",
  );
  assert.equal(plan.type, "AAAA");
  assert.deepEqual(plan.posts.map(x => x.type), ["AAAA", "AAAA"]);
});

test("planDnsRecordSync preserves current candidates and respects max changes", () => {
  const existing = [
    { id: "old-1", content: "104.16.0.1" },
    { id: "old-2", content: "104.16.0.9" },
    { id: "old-3", content: "104.16.0.8" },
  ];
  const plan = planDnsRecordSync(
    "cf.example.com",
    [{ ip: "104.16.0.1" }, { ip: "104.16.0.2" }, { ip: "104.16.0.3" }],
    3,
    existing,
    0.34,
  );
  assert.deepEqual(plan.ips, ["104.16.0.1", "104.16.0.2", "104.16.0.9"]);
  assert.deepEqual(plan.deletes, ["old-3"]);
  assert.deepEqual(plan.posts.map(x => x.content), ["104.16.0.2"]);
  assert.equal(plan.maxChanges, 1);
});

test("planDnsRecordSync deletes unmanaged existing records outside wanted set", () => {
  const existing = [
    { id: "keep", content: "104.16.0.1" },
    { id: "drop", content: "104.16.0.99" },
  ];
  const plan = planDnsRecordSync(
    "cf.example.com",
    [{ ip: "104.16.0.1" }, { ip: "104.16.0.2" }],
    2,
    existing,
    1,
  );
  assert.deepEqual(plan.deletes, ["drop"]);
  assert.deepEqual(plan.posts.map(x => x.content), ["104.16.0.2"]);
});

test("planDnsRecordSync skips empty candidate list", () => {
  assert.deepEqual(planDnsRecordSync("cf.example.com", [], 2, []), {
    skipped: true,
    name: "cf.example.com",
    type: "A",
  });
});
