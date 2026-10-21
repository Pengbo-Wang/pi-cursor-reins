// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Cursor's native AskQuestion interaction, served by Pi's `ask_user_question`
 * tool (rpiv-ask-user-question). The query becomes a regular Pi tool call so
 * the questionnaire renders in Pi's own UI; the answer is encoded back into
 * AskQuestionResult on continuation.
 */
import {
  encodeAskQuestionError,
  encodeAskQuestionRejected,
  encodeAskQuestionSuccess,
  type AskQuestionAnswer,
  type AskQuestionQuery,
} from "../proto/agent.ts";

export const PI_ASK_TOOL = "ask_user_question";

/** Pi tool limits (rpiv-ask-user-question tool/types.ts); out-of-range input is rejected there. */
const MAX_QUESTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const MAX_HEADER = 16;
const MAX_LABEL = 60;
/** Pi appends its own free-text row; authoring these labels is a validation error. */
const RESERVED_LABELS = new Set(["other", "type something.", "type something", "next"]);

export interface AskQuestionLift {
  /** Per Pi question (same index): Cursor question id and Pi label → Cursor option id. */
  questions: { id: string; optionIds: Map<string, string> }[];
}

export type AskQuestionTranslation =
  | { ok: true; args: { questions: PiQuestion[] }; lift: AskQuestionLift }
  | { ok: false; message: string };

interface PiQuestion {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

function unavailable(reason: string): string {
  return (
    `${reason} The user never saw the questions — do NOT treat this as a decline. ` +
    `Ask again with at most ${String(MAX_QUESTIONS)} questions of ${String(MIN_OPTIONS)}-${String(MAX_OPTIONS)} options each, ` +
    "or ask the questions as plain chat text."
  );
}

export function findAskTool(...toolsets: ReadonlyArray<{ name: string }>[]): boolean {
  return toolsets.some((tools) => tools.some((t) => t.name === PI_ASK_TOOL));
}

export function translateAskQuestion(query: AskQuestionQuery): AskQuestionTranslation {
  const count = query.questions.length;
  if (count === 0) return { ok: false, message: unavailable("AskQuestion carried no questions.") };
  if (count > MAX_QUESTIONS) {
    return { ok: false, message: unavailable(`Pi can ask at most ${String(MAX_QUESTIONS)} questions at once (got ${String(count)}).`) };
  }
  const title = query.title.trim();
  const seenPrompts = new Set<string>();
  const questions: PiQuestion[] = [];
  const lift: AskQuestionLift = { questions: [] };
  for (const [index, q] of query.questions.entries()) {
    const optionIds = new Map<string, string>();
    const options: PiQuestion["options"] = [];
    for (const option of q.options) {
      const full = option.label.trim();
      if (full === "" || RESERVED_LABELS.has(full.toLowerCase())) continue;
      const label = clip(full, MAX_LABEL);
      if (optionIds.has(label)) continue;
      optionIds.set(label, option.id);
      options.push({ label, description: label === full ? "" : full });
    }
    if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
      return {
        ok: false,
        message: unavailable(
          `Pi questions need ${String(MIN_OPTIONS)}-${String(MAX_OPTIONS)} options (question ${String(index + 1)} has ${String(options.length)}).`,
        ),
      };
    }
    let prompt = q.prompt.trim() || title || `Question ${String(index + 1)}`;
    if (seenPrompts.has(prompt)) prompt = `${prompt} (${String(index + 1)})`;
    seenPrompts.add(prompt);
    questions.push({
      question: prompt,
      header: count === 1 && title !== "" ? clip(title, MAX_HEADER) : `Question ${String(index + 1)}`,
      options,
      multiSelect: q.allowMultiple,
    });
    lift.questions.push({ id: q.id, optionIds });
  }
  return { ok: true, args: { questions }, lift };
}

interface PiAnswer {
  questionIndex?: unknown;
  kind?: unknown;
  answer?: unknown;
  selected?: unknown;
  notes?: unknown;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function joinText(...parts: (string | undefined)[]): string | undefined {
  const kept = parts.filter((p): p is string => p !== undefined);
  return kept.length > 0 ? kept.join("\n") : undefined;
}

function toCursorAnswer(question: AskQuestionLift["questions"][number], answer: PiAnswer): AskQuestionAnswer {
  const selected: string[] = [];
  const unmatched: string[] = [];
  const labels =
    answer.kind === "multi"
      ? (Array.isArray(answer.selected) ? answer.selected : []).filter((l): l is string => typeof l === "string")
      : answer.kind === "option" && typeof answer.answer === "string"
        ? [answer.answer]
        : [];
  for (const label of labels) {
    const id = question.optionIds.get(label);
    if (id !== undefined) selected.push(id);
    else unmatched.push(label);
  }
  const typed = answer.kind === "option" ? undefined : str(answer.answer);
  const freeformText = joinText(...unmatched, typed, str(answer.notes));
  return { questionId: question.id, selectedOptionIds: selected, ...(freeformText ? { freeformText } : {}) };
}

/** AskQuestionInteractionResponse bytes for the Pi tool result answering `lift`. */
export function encodeAskQuestionFromPi(
  lift: AskQuestionLift,
  text: string,
  isError: boolean,
  details: unknown,
): Uint8Array {
  if (isError) return encodeAskQuestionError(text);
  const d = details !== null && typeof details === "object" ? (details as Record<string, unknown>) : undefined;
  if (d === undefined) {
    if (text.startsWith("User declined")) return encodeAskQuestionRejected(text);
    const first = lift.questions[0];
    return encodeAskQuestionSuccess(first ? [{ questionId: first.id, selectedOptionIds: [], freeformText: text }] : []);
  }
  if (typeof d.error === "string") return encodeAskQuestionError(text);
  if (d.cancelled === true) return encodeAskQuestionRejected("The user dismissed the questions without answering.");
  const answers = Array.isArray(d.answers) ? (d.answers as PiAnswer[]) : [];
  const out: AskQuestionAnswer[] = [];
  for (const [index, question] of lift.questions.entries()) {
    const answer = answers.find((a) => a?.questionIndex === index);
    if (answer) out.push(toCursorAnswer(question, answer));
  }
  const note = str(d.globalNote);
  if (note !== undefined && out[0]) out[0].freeformText = joinText(out[0].freeformText, `Note: ${note}`);
  return encodeAskQuestionSuccess(out);
}
