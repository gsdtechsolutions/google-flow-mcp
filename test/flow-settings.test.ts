import assert from "node:assert/strict";
import test from "node:test";

import { assertWithinCreditLimit, matchMention, parseCreditLine, settingsErrors } from "../src/flow-settings.js";

test("valid image and video combinations pass", () => {
  assert.deepEqual(settingsErrors({ type: "image", model: "Nano Banana 2.1", aspectRatio: "4:3", outputs: 1 }), []);
  assert.deepEqual(settingsErrors({ type: "video", model: "Omni 1.1 Flash", aspectRatio: "9:16", outputs: 2, durationSeconds: 4, resolution: "360p" }), []);
  assert.deepEqual(settingsErrors({ type: "video", model: "Veo 3.1 - Quality", aspectRatio: "16:9", outputs: 4 }), []);
  assert.deepEqual(settingsErrors({ type: "video", model: "Veo 3.1 - Lite", aspectRatio: "16:9", outputs: 1, durationSeconds: 8, resolution: "720p" }), []);
});

test("invalid combinations are rejected", () => {
  const errors = (settings: Parameters<typeof settingsErrors>[0]) => settingsErrors(settings).join(" ");
  assert.match(errors({ type: "video", model: "Nano Banana 2.1", aspectRatio: "16:9", outputs: 1 }), /image model/);
  assert.match(errors({ type: "video", model: "Veo 3.1 - Fast", aspectRatio: "16:9", outputs: 1, durationSeconds: 4 }), /durationSeconds 4/);
  assert.match(errors({ type: "video", model: "Veo 3.1 - Fast", aspectRatio: "16:9", outputs: 1, resolution: "360p" }), /resolution 360p/);
  assert.match(errors({ type: "video", model: "Omni 1.1 Flash", aspectRatio: "1:1", outputs: 1, durationSeconds: 4, resolution: "720p" }), /aspectRatio 1:1/);
  assert.match(errors({ type: "video", model: "Omni 1.1 Flash", aspectRatio: "16:9", outputs: 1 }), /durationSeconds is required/);
  assert.match(errors({ type: "image", model: "Nano Banana Pro", aspectRatio: "16:9", outputs: 1, durationSeconds: 8 }), /not available/);
  assert.match(errors({ type: "image", model: "Nano Banana Pro", aspectRatio: "16:9", outputs: 1, videoMode: "frames" }), /only for video/);
});

test("credit line parsing", () => {
  assert.equal(parseCreditLine("Video\nGenerating will use 4 credits\nx1"), 4);
  assert.equal(parseCreditLine("Generating will use 1 credit"), 1);
  assert.equal(parseCreditLine("Generating will use 0 credits"), 0);
  assert.equal(parseCreditLine("Generating will use 1,200 credits"), 1200);
  assert.equal(parseCreditLine("Settings"), undefined);
});

test("maxCredits decision", () => {
  assert.doesNotThrow(() => assertWithinCreditLimit(0, 0));
  assert.doesNotThrow(() => assertWithinCreditLimit(4, 4));
  assert.throws(() => assertWithinCreditLimit(4, 3), /4 credits, above maxCredits 3/);
  assert.throws(() => assertWithinCreditLimit(undefined, 100), /Could not read/);
});

test("mentions pick the longest whole-name match", () => {
  assert.equal(matchMention("Rae smiling", ["Rae", "VibeGate Rae"]), "Rae");
  assert.equal(matchMention("VibeGate Rae waves", ["VibeGate Rae", "Rae"]), "VibeGate Rae");
  assert.equal(matchMention("Rae, smiling", ["Rae"]), "Rae");
  assert.equal(matchMention("Raelyn smiling", ["Rae"]), undefined);
  assert.equal(matchMention("Bob", ["Rae"]), undefined);
});
