import assert from "node:assert/strict";
import test from "node:test";

test("gate probe", () => assert.fail("deliberate: a red job must turn CI gate red"));
