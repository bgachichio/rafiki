import assert from "node:assert/strict";
import { test } from "node:test";
import { clockOf, parseWhen } from "../src/when.ts";

const OFF = 180; // East Africa Time
const NOW = Date.UTC(2026, 9, 2, 19, 58); // Fri 02-10-2026 22:58 EAT
const at = (d: number, h: number, m = 0): number => Date.UTC(2026, 9, d, h - 3, m);

const CASES: [string, number | null][] = [
  ["remind me to call John in 2 days, morning hours", at(4, 9)],
  ["call John in two days in the morning", at(4, 9)],
  ["in 2 days at 3pm send the invoice", at(4, 15)],
  ["in 3 days", NOW + 3 * 86400000],
  ["in a couple of days", NOW + 2 * 86400000],
  ["in 10 minutes", NOW + 600000],
  ["in an hour", NOW + 3600000],
  ["tomorrow", at(3, 9)],
  ["tomorrow morning", at(3, 9)],
  ["first thing tomorrow", at(3, 9)],
  ["tomorrow afternoon", at(3, 14)],
  ["tomorrow evening", at(3, 18)],
  ["tomorrow at noon", at(3, 12)],
  ["tmrw 7:15am gym", at(3, 7, 15)],
  ["the day after tomorrow at noon", at(4, 12)],
  ["on Monday", at(5, 9)],
  ["next monday morning", at(5, 9)],
  ["on tue at 10:30", at(6, 10, 30)],
  ["Friday 5pm", at(9, 17)], // it is already Friday night, so the next Friday
  ["wednesday evening", at(7, 18)],
  ["at 5", at(3, 17)], // 17:00 has passed today, so tomorrow
  ["at 9", at(3, 9)],
  ["by 6pm", at(3, 18)],
  ["remind me about the 3pm meeting tomorrow", at(3, 15)],
  ["this afternoon", null], // said at 22:58: too late today, and not code's call to move it
  ["tonight", null],
  ["Friday and Monday", null],
  ["at 3pm or 4pm", null],
  ["remind me about the quote", null],
  ["lunch 650 mpesa", null],
  ["in 9999 days", null],
];

test("when: a table of everyday phrases, each read by code", () => {
  for (const [text, want] of CASES) assert.equal(parseWhen(text, NOW, OFF), want, text);
});

test("when: the owner's own morning time is used for 'morning' and a bare day", () => {
  assert.equal(parseWhen("tomorrow morning", NOW, OFF, 7 * 60 + 30), at(3, 7, 30));
  assert.equal(parseWhen("on Monday", NOW, OFF, 8 * 60), at(5, 8));
});

test("when: clock times are read in all the usual shapes, and two different ones are ambiguous", () => {
  assert.equal(clockOf("at 9.30am").min, 9 * 60 + 30);
  assert.equal(clockOf("17:45").min, 17 * 60 + 45);
  assert.equal(clockOf("12pm").min, 12 * 60);
  assert.equal(clockOf("in 5 minutes").count, 0);
  assert.equal(clockOf("3pm or 5pm").count, 2);
});
