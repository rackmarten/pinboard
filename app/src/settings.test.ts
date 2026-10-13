import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_USE_EFFORT_SCALING, resolveUseEffortScaling, validateBoolean } from "./settings.js";

test("effort scaling is on when the operator never set it", () => {
  assert.equal(DEFAULT_USE_EFFORT_SCALING, true);
  assert.equal(resolveUseEffortScaling(null), true);
  assert.equal(resolveUseEffortScaling(undefined), true);
});

test("an explicit operator choice wins over the default", () => {
  assert.equal(resolveUseEffortScaling(false), false);
  assert.equal(resolveUseEffortScaling(true), true);
});

test("the toggle only accepts a real boolean", () => {
  assert.equal(validateBoolean(false, "useEffortScaling"), false);
  assert.throws(() => validateBoolean("false", "useEffortScaling"), /useEffortScaling must be true or false/);
  assert.throws(() => validateBoolean(0, "useEffortScaling"));
});
