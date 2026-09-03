import assert from "node:assert/strict";
import test from "node:test";

import { hasMath, mathToText, parseMath } from "./mathtext.ts";

test("splits superscripts and subscripts onto their own baselines", () => {
  const runs = parseMath("m s^{-1}");
  assert.deepEqual(runs.map((run) => run.text), ["m s", "-1"]);
  assert.equal(runs[0].shift, 0);
  assert.ok(runs[1].shift > 0, "superscript did not rise");
  assert.ok(runs[1].scale < 1, "superscript was not reduced");

  const single = parseMath("x^2 and T_0");
  assert.deepEqual(single.map((run) => run.text), ["x", "2", " and T", "0"]);
  assert.ok(single[3].shift < 0, "subscript did not drop");
});

test("expands the Greek and operator names, inside scripts too", () => {
  assert.equal(parseMath("\\theta").map((r) => r.text).join(""), "θ");
  assert.equal(parseMath("5 \\times 10^{\\circ}")[1].text, "°");
  // An unknown name stays as typed, so a typo is visible rather than dropped.
  assert.equal(parseMath("\\notaname").map((r) => r.text).join(""), "\\notaname");
});

test("leaves plain text as one run and reports whether markup is present", () => {
  const runs = parseMath("Wind speed");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].shift, 0);
  assert.equal(hasMath("Wind speed"), false);
  assert.equal(hasMath("m s^{-1}"), true);
});

test("an unclosed brace is printed, not swallowed", () => {
  assert.equal(parseMath("m s^{-1").map((r) => r.text).join(""), "m s^{-1");
});

test("mathToText gives Unicode superscripts for a tooltip", () => {
  assert.equal(mathToText("m s^{-1}"), "m s⁻¹");
  assert.equal(mathToText("\\theta_e"), "θe");
  // No Unicode form for letters, so the markup stays legible instead.
  assert.equal(mathToText("x^{n}"), "x^n");
});
