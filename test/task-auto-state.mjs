import assert from "node:assert/strict";
import {
  hasJobTotpKey,
  isReauthorizationComplete,
  isTotpRotationComplete,
} from "../src/task-auto-state.mjs";

const internalCompletedRotation = {
  status: "completed",
  lastOperationType: "replace_2fa",
  totpSecret: "NB2W45DFOIZAQWER",
  hasTotpCredential: true,
  totpRotationIncomplete: false,
};
assert.equal(hasJobTotpKey(internalCompletedRotation), true);
assert.equal(isTotpRotationComplete(internalCompletedRotation), true);

const publicCompletedRotation = {
  status: "completed",
  lastOperationType: "replace_2fa",
  hasTotpKey: true,
  totpRotationIncomplete: false,
};
assert.equal(hasJobTotpKey(publicCompletedRotation), false);
assert.equal(isTotpRotationComplete(publicCompletedRotation), false);

assert.equal(isTotpRotationComplete({
  ...internalCompletedRotation,
  totpRotationIncomplete: true,
}), false);
assert.equal(isReauthorizationComplete({
  status: "completed",
  lastOperationType: "relogin",
  resultSaved: true,
}), true);
assert.equal(isReauthorizationComplete({
  status: "completed",
  lastOperationType: "relogin",
  resultSaved: false,
}), false);

console.log("task auto-state predicate smoke passed: internal job fields and subsequent stages");
