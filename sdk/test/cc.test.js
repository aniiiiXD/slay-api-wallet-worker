/**
 * These assert the float behaviour they are contrasting against, measured
 * rather than assumed — an earlier draft of this file predicted three float
 * results and got all three wrong, which is a good argument for not
 * predicting them.
 *
 * They also record where floats DON'T break, because a library whose stated
 * reason is exaggerated gets distrusted on the parts that matter.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as cc from "../dist/cc.js";

test("the famous float example does NOT actually bite at 6dp", () => {
  // Worth pinning down: 0.1 + 0.2 is visibly wrong as a double...
  assert.equal(0.1 + 0.2, 0.30000000000000004);
  // ...but rounding back to micro-CC recovers the right answer, so this is
  // not the reason to avoid floats here. Overstating it would be a lie that
  // costs the library credibility on the failures that are real.
  assert.equal(Math.round((0.1 + 0.2) * 1e6), 300000);
  assert.equal(cc.add("0.1", "0.2"), "0.300000");

  // Same for accumulation at a realistic scale.
  let acc = 0;
  for (let i = 0; i < 10_000; i++) acc += 0.000001;
  assert.equal(Math.round(acc * 1e6), 10_000);
});

test("where floats DO break: parsing", () => {
  // Not an error. One.
  assert.equal(parseFloat("1,000"), 1);
  assert.throws(() => cc.toMicro("1,000"), TypeError);
});

test("where floats DO break: rounding for display", () => {
  // Both round DOWN where a person expects up — the stored double sits a
  // hair below the decimal. Fee and invoice code hits this constantly.
  assert.equal((1.005).toFixed(2), "1.00");
  assert.equal((8.575).toFixed(2), "8.57");
  // We do not paper over it silently: precision beyond the ledger's is refused.
  assert.throws(() => cc.toMicro("1.0050001"), RangeError);
  assert.equal(cc.format("1.005000"), "1.005");
});

test("string comparison is wrong for money; compare() is not", () => {
  assert.ok("9" > "10"); // lexicographic — 9 sorts after 10
  assert.equal(cc.compare("9", "10"), -1);
  assert.ok(cc.lt("9", "10"));
  assert.ok(cc.gt("10.000001", "10"));
  assert.ok(cc.eq("3", "3.000000"));
  assert.ok(cc.eq("3.5", "3.50"));
});

test("round trips preserve exact value", () => {
  for (const v of ["0", "1", "3.5", "87.105300", "0.000001", "999999.999999", "-3.000000"]) {
    assert.equal(cc.fromMicro(cc.toMicro(v)), cc.fromMicro(cc.toMicro(cc.fromMicro(cc.toMicro(v)))));
  }
  assert.equal(cc.fromMicro(cc.toMicro("3.5")), "3.500000");
  assert.equal(cc.fromMicro(cc.toMicro("-0.000001")), "-0.000001");
});

test("rejects what parseFloat would silently accept", () => {
  // Every one of these parseFloat turns into a number; two of them wrongly.
  assert.equal(parseFloat("1e3"), 1000);
  assert.equal(parseFloat("1,000"), 1); // <- silently 1
  assert.ok(Number.isNaN(parseFloat("")));

  for (const bad of ["1e3", "1,000", "", "  ", "abc", "1.2.3", "Infinity", "NaN", "0x10"]) {
    assert.throws(() => cc.toMicro(bad), TypeError, `should reject ${JSON.stringify(bad)}`);
  }
});

test("refuses more precision than the ledger has, rather than rounding for you", () => {
  assert.throws(() => cc.toMicro("1.1234567"), RangeError);
  assert.equal(cc.toMicro("1.123456"), 1123456n);
});

test("basisPoints truncates, and says so", () => {
  assert.equal(cc.basisPoints("100", 250), "2.500000"); // 2.5%
  assert.equal(cc.basisPoints("1", 1), "0.000100"); // 0.01%
  // 3.000001 * 1bp = 0.0000030000010 -> truncates toward zero, never up
  assert.equal(cc.basisPoints("3.000001", 1), "0.000300");
  assert.throws(() => cc.basisPoints("1", 1.5), TypeError);
  assert.throws(() => cc.basisPoints("1", -1), TypeError);
});

test("times() refuses a fractional factor instead of picking a rounding policy", () => {
  assert.equal(cc.times("2.5", 4), "10.000000");
  assert.throws(() => cc.times("2.5", 0.5), TypeError);
});

test("sum of an empty list is zero, not a throw", () => {
  assert.equal(cc.sum([]), "0.000000");
  assert.equal(cc.sum(["1.5", "2.25", "0.25"]), "4.000000");
});

test("format trims for display only", () => {
  assert.equal(cc.format("87.105300"), "87.1053");
  assert.equal(cc.format("3.000000"), "3.00");
  assert.equal(cc.format("3.000000", 0), "3");
  assert.equal(cc.format("0.000001"), "0.000001");
});

test("negatives behave", () => {
  assert.ok(cc.isNegative("-3.000000"));
  assert.equal(cc.abs("-3.5"), "3.500000");
  assert.equal(cc.add("-3", "5"), "2.000000");
  assert.equal(cc.sub("3", "5"), "-2.000000");
  assert.ok(cc.isZero("0.000000"));
});

test("large amounts do not lose precision the way doubles would", () => {
  // 2^53 micro-CC is past a double's exact integer range.
  const big = "9007199254.740993";
  assert.equal(cc.add(big, "0.000001"), "9007199254.740994");
  // The float route does not merely lose the last digit — it lands two
  // micro-CC away from the right answer, in the wrong direction.
  const viaFloat = Number("9007199254.740993") + 0.000001;
  assert.equal(viaFloat, 9007199254.740995);
  assert.notEqual(viaFloat.toFixed(6), "9007199254.740994");
});
