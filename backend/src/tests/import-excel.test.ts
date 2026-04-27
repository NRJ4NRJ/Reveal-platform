/**
 * ITER13 — Tests unitaires du parseur d'import Excel
 * Exécuter avec : npm test (ts-node src/tests/import-excel.test.ts)
 *
 * Ces fonctions sont des copies exactes de celles présentes dans
 * frontend/src/pages/super-admin/Questions.tsx (section "ITER13: Excel parser functions").
 * Si tu modifies les fonctions dans le frontend, répercute ici.
 */

import assert from "assert";

// ─── Types ────────────────────────────────────────────────────────────────────
interface ParsedQuestion {
  _rowIndex: number;
  _format: "A" | "B";
  _selected: boolean;
  _alert: "NO_CORRECT" | "ALL_CORRECT" | "NO_ANSWERS" | null;
  question_text: string;
  type: string;
  level: string;
  theme: string;
  sub_theme_1: string;
  sub_theme_2: string;
  correct_answers: string[];
  distractors: string[];
}

// ─── Parser functions (copied from frontend/src/pages/super-admin/Questions.tsx) ──
function getCellValue(row: any[], index: number | undefined): string | null {
  if (index === undefined || index === null) return null;
  const val = row[index];
  if (val === undefined || val === null) return null;
  return val.toString();
}

function normalizeBoolean(value: any): boolean | null {
  if (value === null || value === undefined) return null;
  const v = value.toString().toLowerCase().trim();
  if (["oui","yes","vrai","true","1","o","y","v"].includes(v)) return true;
  if (["non","no","faux","false","0","n","f"].includes(v)) return false;
  return null;
}

function detectImportFormat(headers: string[]): "A" | "B" | "UNKNOWN" {
  const hl = headers.map(h => h.toString().toLowerCase().trim());
  if (hl.some(h => ["correcte","correct","is correct","bonne réponse","bonne reponse"].includes(h))) return "A";
  const hr = headers.map(h => h.toString().trim());
  if (hr.some(h =>
    h.startsWith("✅") ||
    h.toLowerCase().startsWith("[c]") ||
    h.toLowerCase().startsWith("correct:") ||
    h.toLowerCase().startsWith("bonne:") ||
    h.toLowerCase().startsWith("good:")
  )) return "B";
  return "UNKNOWN";
}

function parseFormatA(rows: any[][], headers: string[]): ParsedQuestion[] {
  const col: Record<string, number> = {};
  headers.forEach((h, i) => {
    const k = h.toString().toLowerCase().trim();
    if (k === "question") col.question = i;
    else if (k === "type") col.type = i;
    else if (["niveau","level"].includes(k)) col.level = i;
    else if (["grand thème","grand theme","main theme"].includes(k)) col.theme = i;
    else if (["sous-thème 1","sous-theme 1","sub-theme 1","sub theme 1"].includes(k)) col.sub1 = i;
    else if (["sous-thème 2","sous-theme 2","sub-theme 2","sub theme 2"].includes(k)) col.sub2 = i;
    else if (["réponse proposée","reponse proposee","proposed answer","answer","réponse","reponse"].includes(k)) col.answer = i;
    else if (["correcte","correct","is correct","bonne réponse","bonne reponse"].includes(k)) col.isCorrect = i;
  });
  const questions: ParsedQuestion[] = [];
  let cur: ParsedQuestion | null = null;
  rows.forEach((row, ri) => {
    const qt = getCellValue(row, col.question);
    const ans = getCellValue(row, col.answer);
    const ic = getCellValue(row, col.isCorrect);
    if (qt && qt.trim()) {
      if (cur) questions.push(cur);
      cur = {
        _rowIndex: ri + 2, _format: "A", _selected: true, _alert: null,
        question_text: qt.trim(),
        type: getCellValue(row, col.type)?.trim() || "",
        level: getCellValue(row, col.level)?.trim() || "",
        theme: getCellValue(row, col.theme)?.trim() || "",
        sub_theme_1: getCellValue(row, col.sub1)?.trim() || "",
        sub_theme_2: getCellValue(row, col.sub2)?.trim() || "",
        correct_answers: [], distractors: [],
      };
    }
    if (cur && ans && ans.trim()) {
      const ok = normalizeBoolean(ic);
      if (ok === true)  cur.correct_answers.push(ans.trim());
      else if (ok === false) cur.distractors.push(ans.trim());
    }
  });
  if (cur) questions.push(cur);
  return questions;
}

function parseFormatB(rows: any[][], headers: string[]): ParsedQuestion[] {
  const col: Record<string, number> = {};
  const cCols: number[] = [], dCols: number[] = [];
  headers.forEach((h, i) => {
    const raw = h.toString().trim();
    const lo  = raw.toLowerCase();
    if (raw.startsWith("✅") || lo.startsWith("[c]") || lo.startsWith("correct:") || lo.startsWith("bonne:") || lo.startsWith("good:")) { cCols.push(i); return; }
    if (raw.startsWith("❌") || lo.startsWith("[d]") || lo.startsWith("distractor:") || lo.startsWith("mauvaise:") || lo.startsWith("wrong:") || lo.startsWith("bad:"))  { dCols.push(i); return; }
    if (lo === "question") col.question = i;
    else if (lo === "type") col.type = i;
    else if (["niveau","level"].includes(lo)) col.level = i;
    else if (["grand thème","grand theme","main theme"].includes(lo)) col.theme = i;
    else if (["sous-thème 1","sous-theme 1","sub-theme 1","sub theme 1"].includes(lo)) col.sub1 = i;
    else if (["sous-thème 2","sous-theme 2","sub-theme 2","sub theme 2"].includes(lo)) col.sub2 = i;
  });
  return rows
    .map((row, ri) => ({
      _rowIndex: ri + 2, _format: "B" as const, _selected: true, _alert: null as null,
      question_text: getCellValue(row, col.question)?.trim() || "",
      type: getCellValue(row, col.type)?.trim() || "",
      level: getCellValue(row, col.level)?.trim() || "",
      theme: getCellValue(row, col.theme)?.trim() || "",
      sub_theme_1: getCellValue(row, col.sub1)?.trim() || "",
      sub_theme_2: getCellValue(row, col.sub2)?.trim() || "",
      correct_answers: cCols.map(i => getCellValue(row, i)).filter((v): v is string => !!v?.trim()).map(v => v.trim()),
      distractors:     dCols.map(i => getCellValue(row, i)).filter((v): v is string => !!v?.trim()).map(v => v.trim()),
    }))
    .filter(q => q.question_text !== "");
}

function computeAlert(q: ParsedQuestion): "NO_CORRECT" | "ALL_CORRECT" | "NO_ANSWERS" | null {
  const t = q.type.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
  const isOpen = ["ouvert","open","scenario","scenar"].some(k => t.includes(k));
  if (isOpen) return null;
  if (q.correct_answers.length === 0 && q.distractors.length === 0) return "NO_ANSWERS";
  if (q.correct_answers.length === 0) return "NO_CORRECT";
  if (q.distractors.length === 0) return "ALL_CORRECT";
  return null;
}

// ─── Mini test runner ─────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (e: any) {
    console.error(`  ❌  ${name}`);
    console.error(`       ${e.message}`);
    failed++;
  }
}

function section(title: string): void {
  console.log(`\n─── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. normalizeBoolean
// ─────────────────────────────────────────────────────────────────────────────
section("normalizeBoolean");

test("OUI → true",   () => assert.strictEqual(normalizeBoolean("OUI"),   true));
test("oui → true",   () => assert.strictEqual(normalizeBoolean("oui"),   true));
test("Yes → true",   () => assert.strictEqual(normalizeBoolean("Yes"),   true));
test("VRAI → true",  () => assert.strictEqual(normalizeBoolean("VRAI"),  true));
test("true → true",  () => assert.strictEqual(normalizeBoolean("true"),  true));
test("1 → true",     () => assert.strictEqual(normalizeBoolean("1"),     true));
test("O → true",     () => assert.strictEqual(normalizeBoolean("O"),     true));
test("Y → true",     () => assert.strictEqual(normalizeBoolean("Y"),     true));
test("V → true",     () => assert.strictEqual(normalizeBoolean("V"),     true));

test("NON → false",   () => assert.strictEqual(normalizeBoolean("NON"),   false));
test("no → false",    () => assert.strictEqual(normalizeBoolean("no"),    false));
test("FAUX → false",  () => assert.strictEqual(normalizeBoolean("FAUX"),  false));
test("false → false", () => assert.strictEqual(normalizeBoolean("false"), false));
test("0 → false",     () => assert.strictEqual(normalizeBoolean("0"),     false));
test("N → false",     () => assert.strictEqual(normalizeBoolean("N"),     false));
test("F → false",     () => assert.strictEqual(normalizeBoolean("F"),     false));

test("'' → null",         () => assert.strictEqual(normalizeBoolean(""),        null));
test("null → null",       () => assert.strictEqual(normalizeBoolean(null),      null));
test("undefined → null",  () => assert.strictEqual(normalizeBoolean(undefined), null));
test("'blah' → null",     () => assert.strictEqual(normalizeBoolean("blah"),    null));
test("number 1 → true",   () => assert.strictEqual(normalizeBoolean(1),         true));
test("number 0 → false",  () => assert.strictEqual(normalizeBoolean(0),         false));

// ─────────────────────────────────────────────────────────────────────────────
// 2. detectImportFormat
// ─────────────────────────────────────────────────────────────────────────────
section("detectImportFormat");

test("'Correcte' → A",
  () => assert.strictEqual(detectImportFormat(["Question","Type","Correcte"]), "A"));
test("'correct' lowercase → A",
  () => assert.strictEqual(detectImportFormat(["question","type","correct"]), "A"));
test("'Bonne réponse' → A",
  () => assert.strictEqual(detectImportFormat(["Question","Bonne réponse"]), "A"));
test("'is correct' → A",
  () => assert.strictEqual(detectImportFormat(["Question","Is Correct"]), "A"));

test("'✅ Réponse 1' → B",
  () => assert.strictEqual(detectImportFormat(["Question","✅ Réponse 1","❌ Mauvaise 1"]), "B"));
test("'[C] Answer 1' → B",
  () => assert.strictEqual(detectImportFormat(["Question","[C] Answer 1","[D] Wrong 1"]), "B"));
test("'correct:' prefix → B",
  () => assert.strictEqual(detectImportFormat(["Question","correct:réponse1","wrong:mauvaise1"]), "B"));
test("'bonne:' prefix → B",
  () => assert.strictEqual(detectImportFormat(["Question","bonne:réponse1"]), "B"));
test("'good:' prefix → B",
  () => assert.strictEqual(detectImportFormat(["Question","good:answer1"]), "B"));

test("No recognized column → UNKNOWN",
  () => assert.strictEqual(detectImportFormat(["Col A","Col B","Col C"]), "UNKNOWN"));
test("Empty headers → UNKNOWN",
  () => assert.strictEqual(detectImportFormat([]), "UNKNOWN"));

// ─────────────────────────────────────────────────────────────────────────────
// 3. parseFormatA
// ─────────────────────────────────────────────────────────────────────────────
section("parseFormatA — base cases");

const FA_HEADERS = ["Question","Type","Niveau","Grand thème","Sous-thème 1","Sous-thème 2","Réponse proposée","Correcte"];
//                    0          1       2         3              4               5              6                7

test("QCM standard — 1 bonne réponse, 3 distracteurs", () => {
  const rows = [
    ["Quel EPI ?","QCM","Fondamental","Sécurité","EPI","Protection","Gants","OUI"],
    [null,null,null,null,null,null,"Lunettes","NON"],
    [null,null,null,null,null,null,"Casquette","NON"],
    [null,null,null,null,null,null,"Chaussures","NON"],
  ];
  const result = parseFormatA(rows, FA_HEADERS);
  assert.strictEqual(result.length, 1, "should produce 1 question");
  assert.strictEqual(result[0].question_text, "Quel EPI ?");
  assert.deepStrictEqual(result[0].correct_answers, ["Gants"]);
  assert.deepStrictEqual(result[0].distractors, ["Lunettes","Casquette","Chaussures"]);
  assert.strictEqual(result[0]._format, "A");
  assert.strictEqual(result[0].type, "QCM");
  assert.strictEqual(result[0].level, "Fondamental");
  assert.strictEqual(result[0].theme, "Sécurité");
  assert.strictEqual(result[0].sub_theme_1, "EPI");
  assert.strictEqual(result[0].sub_theme_2, "Protection");
});

test("QCM multi-réponses — 3 correctes, 2 distracteurs", () => {
  const rows = [
    ["Quels EPI ?","QCM","Basique","Sécurité","EPI","Protection","Gants","OUI"],
    [null,null,null,null,null,null,"Lunettes","OUI"],
    [null,null,null,null,null,null,"Tablier","OUI"],
    [null,null,null,null,null,null,"Casquette","NON"],
    [null,null,null,null,null,null,"Sandales","NON"],
  ];
  const result = parseFormatA(rows, FA_HEADERS);
  assert.strictEqual(result.length, 1);
  assert.deepStrictEqual(result[0].correct_answers, ["Gants","Lunettes","Tablier"]);
  assert.deepStrictEqual(result[0].distractors, ["Casquette","Sandales"]);
});

test("Vrai/Faux — Vrai=OUI, Faux=NON", () => {
  const rows = [
    ["Le casque est obligatoire","Vrai/Faux","Fondamental","Sécurité","Règles","Casque","Vrai","OUI"],
    [null,null,null,null,null,null,"Faux","NON"],
  ];
  const result = parseFormatA(rows, FA_HEADERS);
  assert.strictEqual(result.length, 1);
  assert.deepStrictEqual(result[0].correct_answers, ["Vrai"]);
  assert.deepStrictEqual(result[0].distractors, ["Faux"]);
  assert.strictEqual(result[0].type, "Vrai/Faux");
});

test("Question ouverte — colonnes réponse vides", () => {
  const rows = [
    ["Décrivez la procédure d'évacuation","Question ouverte","Avancé","Sécurité","Incidents","Évacuation","",""],
  ];
  const result = parseFormatA(rows, FA_HEADERS);
  assert.strictEqual(result.length, 1);
  assert.deepStrictEqual(result[0].correct_answers, []);
  assert.deepStrictEqual(result[0].distractors, []);
});

test("Questions multiples — 2 questions consécutives", () => {
  const rows = [
    ["Q1 ?","QCM","Fondamental","T","ST","SST","Bonne","OUI"],
    [null,null,null,null,null,null,"Mauvaise","NON"],
    ["Q2 ?","QCM","Basique","T","ST","SST","Correcte","OUI"],
    [null,null,null,null,null,null,"Incorrecte","NON"],
  ];
  const result = parseFormatA(rows, FA_HEADERS);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].question_text, "Q1 ?");
  assert.strictEqual(result[1].question_text, "Q2 ?");
  assert.deepStrictEqual(result[0].correct_answers, ["Bonne"]);
  assert.deepStrictEqual(result[1].correct_answers, ["Correcte"]);
});

test("_rowIndex commence à 2 (ligne 1 = en-têtes)", () => {
  const rows = [
    ["Question test","QCM","Fondamental","T","ST","SST","Réponse","OUI"],
  ];
  const result = parseFormatA(rows, FA_HEADERS);
  assert.strictEqual(result[0]._rowIndex, 2);
});

test("Ligne avec réponse mais valeur Correcte null — ignorée", () => {
  const rows = [
    ["Question ?","QCM","Fondamental","T","ST","SST","Réponse sans flag",null],
  ];
  const result = parseFormatA(rows, FA_HEADERS);
  assert.strictEqual(result.length, 1);
  // The answer has no OUI/NON → not added to correct_answers or distractors
  assert.deepStrictEqual(result[0].correct_answers, []);
  assert.deepStrictEqual(result[0].distractors, []);
});

test("Colonnes en anglais reconnues — 'answer' et 'correct'", () => {
  const engHeaders = ["Question","Type","Level","Main theme","Sub-theme 1","Sub-theme 2","Answer","Correct"];
  const rows = [
    ["Question?","QCM","Fondamental","T","ST","SST","Good","YES"],
    [null,null,null,null,null,null,"Bad","NO"],
  ];
  const result = parseFormatA(rows, engHeaders);
  assert.strictEqual(result.length, 1);
  assert.deepStrictEqual(result[0].correct_answers, ["Good"]);
  assert.deepStrictEqual(result[0].distractors, ["Bad"]);
});

test("Réponse avec espaces autour — trimée", () => {
  const rows = [
    ["Question ?","QCM","Fondamental","T","ST","SST","  Gants  ","OUI"],
    [null,null,null,null,null,null,"  Casquette  ","NON"],
  ];
  const result = parseFormatA(rows, FA_HEADERS);
  assert.deepStrictEqual(result[0].correct_answers, ["Gants"]);
  assert.deepStrictEqual(result[0].distractors, ["Casquette"]);
});

test("Tableau vide → 0 questions", () => {
  const result = parseFormatA([], FA_HEADERS);
  assert.strictEqual(result.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. parseFormatB
// ─────────────────────────────────────────────────────────────────────────────
section("parseFormatB — base cases");

const FB_HEADERS = ["Question","Type","Niveau","Grand thème","Sous-thème 1","Sous-thème 2","✅ Réponse 1","✅ Réponse 2","✅ Réponse 3","❌ Réponse 4","❌ Réponse 5","❌ Réponse 6"];
//                  0          1       2         3              4               5              6               7               8               9               10              11

test("QCM simple — 1 correcte, 3 distracteurs", () => {
  const rows = [
    ["Quel EPI ?","QCM","Fondamental","Sécurité","EPI","Protection","Gants",null,null,"Casquette","Sandales","Cravate"],
  ];
  const result = parseFormatB(rows, FB_HEADERS);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].question_text, "Quel EPI ?");
  assert.deepStrictEqual(result[0].correct_answers, ["Gants"]);
  assert.deepStrictEqual(result[0].distractors, ["Casquette","Sandales","Cravate"]);
  assert.strictEqual(result[0]._format, "B");
});

test("QCM multi-réponses — 3 correctes, 3 distracteurs", () => {
  const rows = [
    ["Quels EPI ?","QCM","Fondamental","Sécurité","EPI","Prot","Gants","Lunettes","Tablier","Casquette","Sandales","Cravate"],
  ];
  const result = parseFormatB(rows, FB_HEADERS);
  assert.deepStrictEqual(result[0].correct_answers, ["Gants","Lunettes","Tablier"]);
  assert.deepStrictEqual(result[0].distractors, ["Casquette","Sandales","Cravate"]);
});

test("Cellules vides ✅ ignorées", () => {
  const rows = [
    ["Q ?","QCM","Fondamental","T","ST","SST","Bonne",null,null,"Mauvaise",null,null],
  ];
  const result = parseFormatB(rows, FB_HEADERS);
  assert.deepStrictEqual(result[0].correct_answers, ["Bonne"]);
  assert.deepStrictEqual(result[0].distractors, ["Mauvaise"]);
});

test("Toutes les colonnes ❌ vides → distractors = []", () => {
  const rows = [
    ["Q ?","QCM","Fondamental","T","ST","SST","Bonne","Bonne2",null,null,null,null],
  ];
  const result = parseFormatB(rows, FB_HEADERS);
  assert.deepStrictEqual(result[0].correct_answers, ["Bonne","Bonne2"]);
  assert.deepStrictEqual(result[0].distractors, []);
});

test("Ligne avec question vide → filtrée", () => {
  const rows = [
    ["Q1 ?","QCM","Fondamental","T","ST","SST","Bonne",null,null,"Mauvaise",null,null],
    [null,"QCM","Fondamental","T","ST","SST","Bonne",null,null,"Mauvaise",null,null],
    ["Q3 ?","QCM","Fondamental","T","ST","SST","Bonne",null,null,"Mauvaise",null,null],
  ];
  const result = parseFormatB(rows, FB_HEADERS);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].question_text, "Q1 ?");
  assert.strictEqual(result[1].question_text, "Q3 ?");
});

test("En-têtes avec préfixes [C]/[D] reconnus", () => {
  const altHeaders = ["Question","Type","Niveau","Grand thème","Sous-thème 1","Sous-thème 2","[C] Bonne 1","[C] Bonne 2","[D] Mauvaise 1"];
  const rows = [
    ["Q ?","QCM","Fondamental","T","ST","SST","Réponse A","Réponse B","Distractor"],
  ];
  const result = parseFormatB(rows, altHeaders);
  assert.deepStrictEqual(result[0].correct_answers, ["Réponse A","Réponse B"]);
  assert.deepStrictEqual(result[0].distractors, ["Distractor"]);
});

test("En-têtes avec préfixes distractor:/mauvaise:/wrong: reconnus", () => {
  const altHeaders = ["Question","Type","Niveau","Grand thème","Sous-thème 1","Sous-thème 2","correct:rep1","distractor:rep2","wrong:rep3"];
  const rows = [
    ["Q ?","QCM","Fondamental","T","ST","SST","Bonne","Mauvaise","AlsoBad"],
  ];
  const result = parseFormatB(rows, altHeaders);
  assert.deepStrictEqual(result[0].correct_answers, ["Bonne"]);
  assert.deepStrictEqual(result[0].distractors, ["Mauvaise","AlsoBad"]);
});

test("_rowIndex commence à 2", () => {
  const rows = [
    ["Q1 ?","QCM","Fondamental","T","ST","SST","Bonne",null,null,"Mauvaise",null,null],
    ["Q2 ?","QCM","Fondamental","T","ST","SST","Bonne",null,null,"Mauvaise",null,null],
  ];
  const result = parseFormatB(rows, FB_HEADERS);
  assert.strictEqual(result[0]._rowIndex, 2);
  assert.strictEqual(result[1]._rowIndex, 3);
});

test("Réponses avec espaces autour — trimées", () => {
  const rows = [
    ["Q ?","QCM","Fondamental","T","ST","SST","  Gants  ",null,null,"  Casquette  ",null,null],
  ];
  const result = parseFormatB(rows, FB_HEADERS);
  assert.deepStrictEqual(result[0].correct_answers, ["Gants"]);
  assert.deepStrictEqual(result[0].distractors, ["Casquette"]);
});

test("Tableau vide → 0 questions", () => {
  const result = parseFormatB([], FB_HEADERS);
  assert.strictEqual(result.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. computeAlert
// ─────────────────────────────────────────────────────────────────────────────
section("computeAlert");

function makeQ(type: string, correct: string[], distractors: string[]): ParsedQuestion {
  return {
    _rowIndex: 2, _format: "A", _selected: true, _alert: null,
    question_text: "Q ?", type, level: "Fondamental",
    theme: "T", sub_theme_1: "ST", sub_theme_2: "SST",
    correct_answers: correct, distractors,
  };
}

test("QCM avec 1 bonne + 3 distracteurs → null", () => {
  assert.strictEqual(computeAlert(makeQ("QCM", ["Bonne"], ["A","B","C"])), null);
});
test("QCM avec 3 bonnes + 2 distracteurs → null", () => {
  assert.strictEqual(computeAlert(makeQ("QCM", ["A","B","C"], ["D","E"])), null);
});
test("QCM sans bonne réponse (0 correct, 3 distrac.) → NO_CORRECT", () => {
  assert.strictEqual(computeAlert(makeQ("QCM", [], ["A","B","C"])), "NO_CORRECT");
});
test("QCM sans distracteur (3 correct, 0 distrac.) → ALL_CORRECT", () => {
  assert.strictEqual(computeAlert(makeQ("QCM", ["A","B","C"], [])), "ALL_CORRECT");
});
test("QCM sans aucune réponse → NO_ANSWERS", () => {
  assert.strictEqual(computeAlert(makeQ("QCM", [], [])), "NO_ANSWERS");
});

test("Vrai/Faux avec bonnes + mauvaises → null", () => {
  assert.strictEqual(computeAlert(makeQ("Vrai/Faux", ["Vrai"], ["Faux"])), null);
});
test("Vrai/Faux sans bonne réponse → NO_CORRECT", () => {
  assert.strictEqual(computeAlert(makeQ("Vrai/Faux", [], ["Faux"])), "NO_CORRECT");
});

test("Question ouverte sans réponse → null (exempte)", () => {
  assert.strictEqual(computeAlert(makeQ("Question ouverte", [], [])), null);
});
test("'ouvert' minuscule → null", () => {
  assert.strictEqual(computeAlert(makeQ("ouvert", [], [])), null);
});
test("'OPEN' uppercase → null", () => {
  assert.strictEqual(computeAlert(makeQ("OPEN", [], [])), null);
});
test("Scénario sans réponse → null (exempte)", () => {
  assert.strictEqual(computeAlert(makeQ("Scénario", [], [])), null);
});
test("'scenario' ASCII → null", () => {
  assert.strictEqual(computeAlert(makeQ("scenario", [], [])), null);
});
test("'SCENARIO' uppercase → null", () => {
  assert.strictEqual(computeAlert(makeQ("SCENARIO", [], [])), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Scénarios combinés end-to-end
// ─────────────────────────────────────────────────────────────────────────────
section("Scénarios end-to-end");

test("Format A : 3 questions → computeAlert appliqué correctement", () => {
  const headers = FA_HEADERS;
  const rows = [
    // Q1: 1 correcte + 2 distracteurs → OK
    ["Q1","QCM","Fondamental","T","ST","SST","Bonne","OUI"],
    [null,null,null,null,null,null,"A","NON"],
    [null,null,null,null,null,null,"B","NON"],
    // Q2: 0 correcte + 1 distracteur → NO_CORRECT
    ["Q2","QCM","Fondamental","T","ST","SST","Mauvaise","NON"],
    // Q3: question ouverte, pas de réponse → null
    ["Q3","Question ouverte","Fondamental","T","ST","SST","",""],
  ];
  const questions = parseFormatA(rows, headers).map(q => ({ ...q, _alert: computeAlert(q) }));
  assert.strictEqual(questions.length, 3);
  assert.strictEqual(questions[0]._alert, null,        "Q1 should be valid");
  assert.strictEqual(questions[1]._alert, "NO_CORRECT","Q2 should have NO_CORRECT");
  assert.strictEqual(questions[2]._alert, null,        "Q3 (ouverte) should be exempt");
});

test("Format B : 2 questions → _selected true par défaut", () => {
  const rows = [
    ["Q1","QCM","Fondamental","T","ST","SST","Bonne",null,null,"Mauvaise",null,null],
    ["Q2","QCM","Fondamental","T","ST","SST","Bonne2",null,null,"Mauvaise2",null,null],
  ];
  const questions = parseFormatB(rows, FB_HEADERS);
  assert.strictEqual(questions.every(q => q._selected), true);
});

test("Nombre de questions sélectionnées après filtrage", () => {
  const rows = [
    ["Q1","QCM","Fondamental","T","ST","SST","Bonne",null,null,"Mauvaise",null,null],
    ["Q2","QCM","Fondamental","T","ST","SST","Bonne2",null,null,"Mauvaise2",null,null],
    ["Q3","QCM","Fondamental","T","ST","SST","Bonne3",null,null,"Mauvaise3",null,null],
  ];
  const questions = parseFormatB(rows, FB_HEADERS);
  // Simulate unchecking Q2
  questions[1]._selected = false;
  const selected = questions.filter(q => q._selected);
  assert.strictEqual(selected.length, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(64)}`);
console.log(`  Résultats : ${passed} passé(s)  /  ${failed} échoué(s)  /  ${passed + failed} total`);
console.log(`${"═".repeat(64)}\n`);

if (failed > 0) {
  process.exit(1);
}
