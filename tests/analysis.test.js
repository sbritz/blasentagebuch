const test = require("node:test");
const assert = require("node:assert/strict");
const analysis = require("../dist/analysis.js");

test("Mittelwert, Median und prozentuale Differenz sind deterministisch", () => {
  assert.equal(analysis.mean([100, 200, 600]), 300);
  assert.equal(analysis.median([600, 100, 200, 400]), 300);
  assert.equal(analysis.percentageDifference(400, 500), 25);
  assert.equal(analysis.percentageDifference(0, 500), null);
});

test("Pearson-Korrelation erkennt lineare Zusammenhänge und zu kleine Stichproben", () => {
  assert.equal(analysis.pearson([[1, 2], [2, 4], [3, 6]]), 1);
  assert.equal(analysis.pearson([[1, 6], [2, 4], [3, 2]]), -1);
  assert.equal(analysis.pearson([[1, 2], [2, 4]]), null);
});

test("Tageswerte werden ausschließlich aus Roh-Einträgen berechnet", () => {
  const entries = [
    { kind: "drink", amount_ml: 250, occurred_at: "2026-09-19T18:00:00Z" },
    { kind: "drink", amount_ml: 400, occurred_at: "2026-09-19T21:30:00Z" },
    { kind: "meal", occurred_at: "2026-09-19T20:00:00Z", tags: ["salty", "large_portion"] },
    { kind: "urination", amount_ml: 200, occurred_at: "2026-09-19T19:00:00Z", phase: "day", urgency: "leicht" },
    { kind: "urination", amount_ml: 300, occurred_at: "2026-09-19T23:30:00Z", phase: "night", urgency: "mittel" },
    { kind: "urination", amount_ml: 400, occurred_at: "2026-09-20T06:00:00Z", phase: "night", morningVoid: true, urgency: "stark" }
  ];
  const result = analysis.computeDayMetrics({
    dayKey: "2026-09-19",
    entries,
    sleepAt: "2026-09-19T23:00:00Z",
    context: { tags: ["stress"] }
  });
  assert.equal(result.intakeMl, 650);
  assert.equal(result.totalUrineMl, 900);
  assert.equal(result.nightUrineMl, 700);
  assert.equal(Math.round(result.nightSharePercent * 10) / 10, 77.8);
  assert.equal(result.dayVisits, 1);
  assert.equal(result.nightVisits, 1);
  assert.equal(result.averageVoidMl, 300);
  assert.equal(result.maximumVoidMl, 400);
  assert.equal(result.urgency.leicht.averageMl, 200);
  assert.equal(result.urgency.mittel.averageMl, 300);
  assert.equal(result.urgency.stark.averageMl, 400);
  assert.equal(result.beforeSleep3hMl, 400);
  assert.equal(result.minutesLastMealToSleep, 180);
  assert.equal(result.minutesLastLargeDrinkToSleep, 90);
  assert.deepEqual(result.mealTags, ["salty", "large_portion"]);
  assert.deepEqual(result.dailyFactors, ["stress"]);
});

test("Tag-Vergleiche liefern Mittelwert, Median sowie absolute und prozentuale Differenz", () => {
  const days = [
    { mealTags: ["salty"], nightUrineMl: 800 },
    { mealTags: ["salty"], nightUrineMl: 1000 },
    { mealTags: [], nightUrineMl: 600 },
    { mealTags: [], nightUrineMl: 700 }
  ];
  const result = analysis.compareTaggedDays(days, "mealTags", "salty", "nightUrineMl");
  assert.equal(result.withMean, 900);
  assert.equal(result.withMedian, 900);
  assert.equal(result.withoutMean, 650);
  assert.equal(result.withoutMedian, 650);
  assert.equal(result.absoluteDifference, 250);
  assert.equal(Math.round(result.percentageDifference * 10) / 10, 38.5);
});

test("Arztbericht wählt höchstens fünf ausreichend belegte Muster deterministisch aus", () => {
  const days = Array.from({ length: 6 }, (_, index) => ({
    dayKey: `2026-09-${String(index + 1).padStart(2, "0")}`,
    beforeSleep3hMl: 200 + index * 100,
    nightUrineMl: 500 + index * 120,
    nightVisits: 1 + Math.floor(index / 2),
    intakeMl: 1600 + index * 150,
    totalUrineMl: 1400 + index * 140,
    mealTags: index >= 3 ? ["salty", "large_portion"] : [],
    dailyFactors: index >= 3 ? ["stress", "cold"] : []
  }));
  const result = analysis.observedPatterns(days, {
    mealTags: ["salty", "large_portion"],
    dailyFactors: ["stress", "cold"],
    maxPatterns: 5
  });
  assert.equal(result.length, 5);
  assert.ok(result.every((pattern) => ["continuous", "mealTag", "dailyFactor"].includes(pattern.kind)));
  assert.ok(result.some((pattern) => pattern.id === "late-intake-night-urine"));
  assert.deepEqual(result, analysis.observedPatterns(days, {
    mealTags: ["salty", "large_portion"],
    dailyFactors: ["stress", "cold"],
    maxPatterns: 5
  }));
});

test("Merkmalsvergleich erscheint erst ab drei Tagen mit diesem Merkmal", () => {
  const days = Array.from({ length: 6 }, (_, index) => ({
    dayKey: `2026-09-${String(index + 1).padStart(2, "0")}`,
    beforeSleep3hMl: 300,
    nightUrineMl: index < 2 ? 900 : 600,
    nightVisits: 2,
    intakeMl: 1800,
    totalUrineMl: 1600,
    mealTags: index < 2 ? ["salty"] : [],
    dailyFactors: []
  }));
  const result = analysis.observedPatterns(days, { mealTags: ["salty"], dailyFactors: [], maxPatterns: 5 });
  assert.equal(result.some((pattern) => pattern.kind === "mealTag" && pattern.tag === "salty"), false);

  days[2].mealTags = ["salty"];
  days[2].nightUrineMl = 900;
  const thresholdResult = analysis.observedPatterns(days, { mealTags: ["salty"], dailyFactors: [], maxPatterns: 5 });
  assert.equal(thresholdResult.some((pattern) => pattern.kind === "mealTag" && pattern.tag === "salty"), true);
});
