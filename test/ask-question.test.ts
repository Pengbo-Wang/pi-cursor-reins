// SPDX-License-Identifier: AGPL-3.0-or-later
/** Cursor AskQuestion ↔ Pi ask_user_question translation. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeAskQuestionFromPi, translateAskQuestion, type AskQuestionLift } from "../src/agent/ask-question.ts";
import { decodeAgentServerMessage, decodeAskQuestionQuery, type AskQuestionItem } from "../src/proto/agent.ts";
import {
  encodeFields,
  expectBytes,
  expectString,
  forEachField,
  skipUnknown,
  writeBool,
  writeBytes,
  writeString,
  writeUint32Always,
} from "../src/proto/wire.ts";

export function askQuestionQueryFrame(id: number, title: string, questions: AskQuestionItem[], toolCallId = "tc-ask"): Uint8Array {
  const args = encodeFields((w) => {
    writeString(w, 1, title);
    for (const q of questions) {
      writeBytes(
        w,
        2,
        encodeFields((qw) => {
          writeString(qw, 1, q.id);
          writeString(qw, 2, q.prompt);
          for (const o of q.options) {
            writeBytes(
              qw,
              3,
              encodeFields((ow) => {
                writeString(ow, 1, o.id);
                writeString(ow, 2, o.label);
              }),
            );
          }
          writeBool(qw, 4, q.allowMultiple);
        }),
      );
    }
  });
  const askQuery = encodeFields((w) => {
    writeBytes(w, 1, args);
    writeString(w, 2, toolCallId);
  });
  const query = encodeFields((w) => {
    writeUint32Always(w, 1, id);
    writeBytes(w, 3, askQuery);
  });
  return encodeFields((w) => writeBytes(w, 7, query));
}

export interface DecodedAskResult {
  arm: number;
  answers: { questionId: string; selectedOptionIds: string[]; freeformText: string }[];
  message: string;
}

/** AskQuestionInteractionResponse bytes → result arm + payload. */
export function decodeAskResult(bytes: Uint8Array): DecodedAskResult {
  const out: DecodedAskResult = { arm: -1, answers: [], message: "" };
  forEachField(bytes, (f, w, r) => {
    if (f !== 1) return skipUnknown(r, w, f);
    forEachField(expectBytes(r, w), (arm, aw, ar) => {
      out.arm = arm;
      forEachField(expectBytes(ar, aw), (pf, pw, pr) => {
        if (arm === 1 && pf === 1) {
          const answer = { questionId: "", selectedOptionIds: [] as string[], freeformText: "" };
          forEachField(expectBytes(pr, pw), (xf, xw, xr) => {
            if (xf === 1) answer.questionId = expectString(xr, xw);
            else if (xf === 2) answer.selectedOptionIds.push(expectString(xr, xw));
            else if (xf === 3) answer.freeformText = expectString(xr, xw);
            else skipUnknown(xr, xw, xf);
          });
          out.answers.push(answer);
        } else if (arm !== 1 && pf === 1) out.message = expectString(pr, pw);
        else skipUnknown(pr, pw, pf);
      });
    });
  });
  return out;
}

const Q_DB: AskQuestionItem = {
  id: "db",
  prompt: "Which database?",
  options: [
    { id: "pg", label: "Postgres" },
    { id: "my", label: "MySQL" },
    { id: "other", label: "Other" },
  ],
  allowMultiple: false,
};
const Q_FEAT: AskQuestionItem = {
  id: "feat",
  prompt: "Which features?",
  options: [
    { id: "a", label: "Auth" },
    { id: "b", label: "Billing" },
    { id: "c", label: "Chat" },
  ],
  allowMultiple: true,
};

test("T-ASK: the query payload decodes through the interaction-query frame", () => {
  const msg = decodeAgentServerMessage(askQuestionQueryFrame(5, "Setup", [Q_DB, Q_FEAT]));
  assert.ok(msg.case === "interactionQuery");
  assert.equal(msg.query.case, "askQuestion");
  assert.equal(msg.query.id, 5);
  const query = decodeAskQuestionQuery(msg.query.payload);
  assert.equal(query.title, "Setup");
  assert.equal(query.toolCallId, "tc-ask");
  assert.deepEqual(query.questions, [Q_DB, Q_FEAT]);
});

test("T-ASK: questions map to Pi args; reserved labels drop, headers fit", () => {
  const t = translateAskQuestion({ toolCallId: "", title: "Project setup questions", questions: [Q_DB, Q_FEAT] });
  assert.ok(t.ok);
  assert.deepEqual(t.args.questions[0], {
    question: "Which database?",
    header: "Question 1",
    options: [
      { label: "Postgres", description: "" },
      { label: "MySQL", description: "" },
    ],
    multiSelect: false,
  });
  assert.equal(t.args.questions[1]?.multiSelect, true);
  const single = translateAskQuestion({ toolCallId: "", title: "Project setup questions", questions: [Q_DB] });
  assert.ok(single.ok);
  assert.equal(single.args.questions[0]?.header, "Project setup q…");
});

test("T-ASK: long labels clip with the full text kept as description", () => {
  const long = "x".repeat(80);
  const t = translateAskQuestion({
    toolCallId: "",
    title: "",
    questions: [{ id: "q", prompt: "Pick", allowMultiple: false, options: [{ id: "1", label: long }, { id: "2", label: "short" }] }],
  });
  assert.ok(t.ok);
  const opt = t.args.questions[0]!.options[0]!;
  assert.equal([...opt.label].length, 60);
  assert.equal(opt.description, long);
  assert.equal(t.lift.questions[0]?.optionIds.get(opt.label), "1");
});

test("T-ASK: out-of-range shapes fail with a not-a-decline message", () => {
  const five = { ...Q_FEAT, options: ["a", "b", "c", "d", "e"].map((id) => ({ id, label: id.toUpperCase() })) };
  for (const questions of [[], [Q_DB, Q_DB, Q_DB, Q_DB, Q_DB], [five], [{ ...Q_DB, options: [Q_DB.options[0]!] }]]) {
    const t = translateAskQuestion({ toolCallId: "", title: "", questions });
    assert.ok(!t.ok);
    assert.match(t.message, /do NOT treat this as a decline/);
  }
});

function liftFor(...questions: AskQuestionItem[]): AskQuestionLift {
  const t = translateAskQuestion({ toolCallId: "", title: "", questions });
  assert.ok(t.ok);
  return t.lift;
}

test("T-ASK: answers map labels back to Cursor option ids; free text rides freeform_text", () => {
  const details = {
    cancelled: false,
    answers: [
      { questionIndex: 0, question: "Which database?", kind: "option", answer: "MySQL" },
      { questionIndex: 1, question: "Which features?", kind: "multi", answer: "Search", selected: ["Auth", "Chat"] },
    ],
    globalNote: "ship fast",
  };
  const r = decodeAskResult(encodeAskQuestionFromPi(liftFor(Q_DB, Q_FEAT), "User has answered...", false, details));
  assert.equal(r.arm, 1, "success");
  assert.deepEqual(r.answers, [
    { questionId: "db", selectedOptionIds: ["my"], freeformText: "Note: ship fast" },
    { questionId: "feat", selectedOptionIds: ["a", "c"], freeformText: "Search" },
  ]);
  const custom = decodeAskResult(
    encodeAskQuestionFromPi(liftFor(Q_DB), "x", false, {
      cancelled: false,
      answers: [{ questionIndex: 0, kind: "custom", answer: "SQLite" }],
    }),
  );
  assert.deepEqual(custom.answers, [{ questionId: "db", selectedOptionIds: [], freeformText: "SQLite" }]);
});

test("T-ASK: Esc is a rejection; UI/tool failures are errors, never declines", () => {
  const lift = liftFor(Q_DB);
  assert.equal(decodeAskResult(encodeAskQuestionFromPi(lift, "User declined to answer questions", false, { answers: [], cancelled: true })).arm, 3);
  const noUi = decodeAskResult(encodeAskQuestionFromPi(lift, "Error: UI not available", false, { answers: [], cancelled: true, error: "no_ui" }));
  assert.equal(noUi.arm, 2);
  assert.equal(noUi.message, "Error: UI not available");
  assert.equal(decodeAskResult(encodeAskQuestionFromPi(lift, "boom", true, undefined)).arm, 2);
  assert.equal(decodeAskResult(encodeAskQuestionFromPi(lift, "User declined to answer questions", false, undefined)).arm, 3);
  const textOnly = decodeAskResult(encodeAskQuestionFromPi(lift, 'User has answered your questions: "Q"="A".', false, undefined));
  assert.equal(textOnly.arm, 1);
  assert.equal(textOnly.answers[0]?.freeformText, 'User has answered your questions: "Q"="A".');
});
