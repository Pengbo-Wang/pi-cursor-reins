// SPDX-License-Identifier: AGPL-3.0-or-later
/** Native exec translation: decode, pi-tool mapping, result encoding (PROTOCOL-AGENT §5.1). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAgentRequest } from "../src/agent/request.ts";
import { mcpContractText, matchToolFor } from "../src/agent/policy.ts";
import {
  decodeNativeArgs,
  encodeNativeResultFromPi,
  nativeExecMode,
  parseReadOutput,
  readFailureText,
  translateNativeToPi,
  unwrapCodemodeResult,
  type NativeArgs,
} from "../src/agent/native.ts";
import type { DecodedExec } from "../src/proto/agent.ts";
import {
  WireType,
  encodeFields,
  expectBytes,
  expectString,
  expectVarint,
  forEachField,
  skipUnknown,
  writeBool,
  writeBytes,
  writeString,
  writeUint32,
} from "../src/proto/wire.ts";
import type { InferenceIR, IrTool } from "../src/session/ir.ts";

function execOf(execCase: DecodedExec["case"], field: number, payload: Uint8Array): DecodedExec {
  return { id: 7, execId: "e1", field, case: execCase, strings: {}, payload };
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): IrTool {
  return { name, description, jsonSchema: { type: "object", properties, required } };
}

const ctxShell = tool("ctx_shell", "Run a shell command", { command: { type: "string" }, timeout: { type: "number" } });
const readTool = tool("read", "Read a file", { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } });
const findTool = tool("fffind", "Find files by name pattern", { pattern: { type: "string" }, path: { type: "string" } });

test("T-NATIVE: mcpContractText lists only tools native translation cannot cover", () => {
  const dice = tool("roll_dice", "Roll dice and return the total.", {
    sides: { type: "number" },
    count: { type: "number" },
  }, ["sides", "count"]);
  const askTool = tool("ask_user_question", "Ask the user.\nSecond line is dropped.", {
    questions: { type: "array" },
    note: { type: "string" },
  }, ["questions"]);
  const all = [ctxShell, readTool, findTool, dice, askTool];
  const text = mcpContractText(all);
  // Core-capable tools are covered by native translation → excluded.
  assert.ok(!text.includes("ctx_shell"), "shell winner excluded");
  assert.ok(!text.includes("mcp_pi_read("), "read winner excluded");
  // Pi-only extras get a one-line signature each.
  assert.match(text, /mcp_pi_roll_dice\(sides, count\) — Roll dice and return the total\./);
  assert.match(text, /mcp_pi_ask_user_question\(questions, note\?\) — Ask the user\./);
  assert.match(text, /namespace "pi"/);
  // No extras → no contract at all.
  assert.equal(mcpContractText([ctxShell, readTool]), "");
});

test("T-NATIVE: mode env parsing", () => {
  assert.equal(nativeExecMode({}), "pi", "translation is the default");
  assert.equal(nativeExecMode({ CURSOR_PROVIDER_NATIVE_EXEC: "" }), "pi");
  assert.equal(nativeExecMode({ CURSOR_PROVIDER_NATIVE_EXEC: "inproc" }), "inproc");
  assert.equal(nativeExecMode({ CURSOR_PROVIDER_NATIVE_EXEC: "1" }), "pi");
  assert.equal(nativeExecMode({ CURSOR_PROVIDER_NATIVE_EXEC: "off" }), "pi", "legacy value is ignored; reject stays the fallback for untranslatable cases");
});

test("T-NATIVE: decodeNativeArgs decodes the translatable cases", () => {
  const shell = decodeNativeArgs(
    execOf(
      "shellArgs",
      2,
      encodeFields((w) => {
        writeString(w, 1, "echo hi");
        writeString(w, 2, "/tmp");
        writeUint32(w, 3, 5000);
        writeString(w, 15, "Run echo command");
      }),
    ),
  );
  assert.deepEqual(shell, { case: "shellArgs", command: "echo hi", workingDirectory: "/tmp", timeoutMs: 5000 });

  const read = decodeNativeArgs(
    execOf(
      "readArgs",
      7,
      encodeFields((w) => {
        writeString(w, 1, "a.txt");
        writeString(w, 2, "call-abc-0"); // tool_call_id, not offset/limit (live wire)
      }),
    ),
  );
  assert.deepEqual(read, { case: "readArgs", path: "a.txt" });

  const write = decodeNativeArgs(
    execOf(
      "writeArgs",
      3,
      encodeFields((w) => {
        writeString(w, 1, "b.txt");
        writeString(w, 2, "body");
      }),
    ),
  );
  assert.deepEqual(write, { case: "writeArgs", path: "b.txt", contents: "body" });

  const grep = decodeNativeArgs(
    execOf(
      "grepArgs",
      5,
      encodeFields((w) => {
        writeString(w, 1, "needle");
        writeBool(w, 2, true);
        writeString(w, 3, "*.ts");
        writeString(w, 4, "/src");
        writeString(w, 11, "files_with_matches");
      }),
    ),
  );
  assert.deepEqual(grep, {
    case: "grepArgs",
    pattern: "needle",
    glob: "*.ts",
    path: "/src",
    caseInsensitive: true,
    outputMode: "files_with_matches",
  });

  assert.equal(decodeNativeArgs(execOf("lsArgs", 8, new Uint8Array())), null);
  assert.equal(decodeNativeArgs(execOf("unknown", 99, new Uint8Array())), null);
});

test("T-NATIVE: shell translates to the capability-matched command tool, schema-adapted", () => {
  const args: NativeArgs = { case: "shellArgs", command: "echo hi", workingDirectory: "/tmp", timeoutMs: 5000 };
  const hit = translateNativeToPi(args, [ctxShell]);
  assert.ok(hit);
  assert.equal(hit.tool.name, "ctx_shell");
  // timeout is dropped (wire unit unverified). pi 0.99 bash has no cwd, so wrap it.
  assert.deepEqual(hit.args, { command: "cd -- '/tmp' && echo hi" });

  const withCwd = tool("ctx_shell", "Run a shell command", {
    command: { type: "string" },
    cwd: { type: "string" },
  });
  const hitCwd = translateNativeToPi(args, [withCwd]);
  assert.deepEqual(hitCwd?.args, { command: "echo hi", cwd: "/tmp" });

  // A tool with no command-ish key can never serve a shell exec.
  assert.equal(translateNativeToPi(args, [tool("echo", "echo", { x: { type: "string" } })]), null);
  assert.equal(translateNativeToPi(args, []), null);
});

test("T-NATIVE: read/write/delete adapt to the tool's own schema keys", () => {
  const read = translateNativeToPi({ case: "readArgs", path: "a.txt" }, [readTool]);
  assert.deepEqual(read?.args, { path: "a.txt" });

  const writeContents = tool("write", "Write a file", { path: { type: "string" }, contents: { type: "string" } });
  const write = translateNativeToPi({ case: "writeArgs", path: "b.txt", contents: "body" }, [writeContents]);
  assert.deepEqual(write?.args, { path: "b.txt", contents: "body" });

  // A write tool whose schema declares neither content nor contents cannot serve.
  assert.equal(
    translateNativeToPi({ case: "writeArgs", path: "b.txt", contents: "body" }, [tool("edit", "Edit", { path: {} })]),
    null,
  );

  // Delete routes through the command tool (pi has no delete tool) with a
  // composite that captures the pre-delete size — a sizeless DeleteSuccess
  // stalls the backend (PROTOCOL-AGENT §5.1).
  const del = translateNativeToPi({ case: "deleteArgs", path: "it's.txt" }, [ctxShell]);
  assert.equal(del?.tool.name, "ctx_shell");
  const delCmd = String(del?.args.command);
  assert.ok(delCmd.includes("rm -- 'it'\\''s.txt'"));
  assert.ok(delCmd.includes("D0:%s"));
  // …and the encoder reports the parsed real size.
  const delReply = encodeNativeResultFromPi({ case: "deleteArgs", path: "/x.txt" }, "D0: 42\n", false);
  let sizeSeen = 0;
  forEachField(delReply.frames[0]!.resultBytes, (f, w, r) => {
    if (f !== 1) return skipUnknown(r, w, f);
    // DeleteResult.success (field 1) = DeleteSuccess {path=1, deleted_file=2, file_size=3}
    forEachField(expectBytes(r, w), (f2, w2, r2) => {
      if (f2 === 3) sizeSeen = expectVarint(r2, w2);
      else skipUnknown(r2, w2, f2);
    });
  });
  assert.equal(sizeSeen, 42);
});

test("T-NATIVE: grep maps content args; empty pattern + glob maps to a find-capable tool", () => {
  const grepTool = tool("ffgrep", "Search file contents", {
    pattern: { type: "string" },
    path: { type: "string" },
    glob: { type: "string" },
    caseSensitive: { type: "boolean" },
  });
  const grep = translateNativeToPi(
    { case: "grepArgs", pattern: "needle", glob: "*.ts", path: "/src", caseInsensitive: true, outputMode: "content" },
    [grepTool],
  );
  assert.equal(grep?.tool.name, "ffgrep");
  assert.deepEqual(grep?.args, { pattern: "needle", path: "/src", glob: "*.ts" }); // no case_insensitive key in schema → dropped

  const glob = translateNativeToPi(
    { case: "grepArgs", pattern: "", glob: "**/b.txt", path: "/src", caseInsensitive: false, outputMode: "files_with_matches" },
    [grepTool, findTool],
  );
  assert.equal(glob?.tool.name, "fffind");
  assert.deepEqual(glob?.args, { pattern: "**/b.txt", path: "/src" });
});

test("T-NATIVE: pi default tools + web tools: Write skips edit, Grep/Glob never hit web search", () => {
  const bash = tool("bash", "Execute a bash command", { command: { type: "string" }, timeout: { type: "number" } });
  const edit = tool("edit", "Edit a file", { path: { type: "string" }, edits: { type: "array" } });
  const write = tool("write", "Write a file", { path: { type: "string" }, content: { type: "string" } });
  const webSearch = tool("web_search", "Search the web", { query: { type: "string" }, queries: { type: "array" } });
  const getContent = tool("get_search_content", "Retrieve stored results of tools", {
    responseId: { type: "string" },
    query: { type: "string" },
  });
  const tools = [readTool, bash, edit, write, webSearch, getContent];

  const w = translateNativeToPi({ case: "writeArgs", path: "/tmp/a.txt", contents: "hi" }, tools);
  assert.equal(w?.tool.name, "write");
  assert.deepEqual(w?.args, { path: "/tmp/a.txt", content: "hi" });

  const grep = translateNativeToPi(
    { case: "grepArgs", pattern: "needle", glob: "*.ts", path: "src", caseInsensitive: false, outputMode: "content" },
    tools,
  );
  assert.equal(grep?.tool.name, "bash");
  assert.match(String(grep?.args.command), /rg -n --no-heading --with-filename --glob '\*\.ts' -- 'needle' 'src'/);

  const glob = translateNativeToPi(
    { case: "grepArgs", pattern: "", glob: "*.json", path: "", caseInsensitive: false, outputMode: "files_with_matches" },
    tools,
  );
  assert.equal(glob?.tool.name, "bash");
  assert.match(String(glob?.args.command), /rg --files --glob '\*\.json' -- \.;/);

  const text = mcpContractText(tools);
  assert.match(text, /mcp_pi_web_search\(/, "web_search is not a grep stand-in, so it stays in the contract");
  assert.match(text, /mcp_pi_edit\(/, "edit is not the Write stand-in, so it stays in the contract");
  assert.ok(!text.includes("mcp_pi_write("));
});

/** Pull (field → string) out of a nested message, for result-shape assertions. */
function stringFields(bytes: Uint8Array): Map<number, string> {
  const out = new Map<number, string>();
  forEachField(bytes, (field, wire, reader) => {
    if (wire === WireType.LengthDelimited) {
      try {
        out.set(field, expectString(reader, wire));
      } catch {
        skipUnknown(reader, wire, field);
      }
    } else skipUnknown(reader, wire, field);
  });
  return out;
}

test("T-NATIVE: pi result encodes to the native shell success/error arms", () => {
  const args: NativeArgs = { case: "shellArgs", command: "echo hi", workingDirectory: "/tmp", timeoutMs: 0 };
  const ok = encodeNativeResultFromPi(args, "hi\n", false);
  assert.equal(ok.closeStream, true, "every native result ends with stream_close (reference client behavior)");
  assert.equal(ok.frames.length, 1);
  assert.equal(ok.frames[0]?.resultField, 2);
  // shell_result.success (1) → stdout (5), exit_code (3)
  let stdout = "";
  let exit = -1;
  forEachField(ok.frames[0]?.resultBytes ?? new Uint8Array(), (field, wire, reader) => {
    if (field === 1) {
      forEachField(expectBytes(reader, wire), (f2, w2, r2) => {
        if (f2 === 5) stdout = expectString(r2, w2);
        else if (f2 === 3) exit = Number(expectVarint(r2, w2));
        else skipUnknown(r2, w2, f2);
      });
    } else skipUnknown(reader, wire, field);
  });
  assert.equal(stdout, "hi\n");
  assert.ok(exit <= 0, "exit_code 0 is omitted on the wire (proto3 default)");

  const bad = encodeNativeResultFromPi(args, "boom", true);  let arm = 0;
  forEachField(bad.frames[0]?.resultBytes ?? new Uint8Array(), (field, wire, reader) => {
    arm = field;
    skipUnknown(reader, wire, field);
  });
  assert.equal(arm, 2, "error maps to the failure arm");
});

test("T-NATIVE: shellStream emits stdout → exit frames and requires stream_close", () => {
  const args: NativeArgs = { case: "shellStreamArgs", command: "echo hi", workingDirectory: "/tmp", timeoutMs: 0 };
  const reply = encodeNativeResultFromPi(args, "hi\n", false);
  assert.equal(reply.closeStream, true);
  assert.equal(reply.frames.length, 2);
  assert.ok(reply.frames.every((f) => f.resultField === 14));
  // First frame: stdout event (oneof field 1); second: exit (oneof field 3).
  const kinds: number[] = [];
  for (const frame of reply.frames) {
    forEachField(frame.resultBytes, (field, wire, reader) => {
      kinds.push(field);
      skipUnknown(reader, wire, field);
    });
  }
  assert.deepEqual(kinds, [1, 3]);
});

test("T-NATIVE: grep content parses file:line:content, falls back to one raw match", () => {
  const args: NativeArgs = { case: "grepArgs", pattern: "needle", glob: "", path: "/src", caseInsensitive: false, outputMode: "content" };
  const parsed = encodeNativeResultFromPi(args, "a.ts:12:const needle = 1\nb.ts:3:needle();\n", false);
  assert.equal(parsed.frames[0]?.resultField, 5);
  const fallback = encodeNativeResultFromPi(args, "Found 2 matches in 2 files", false);
  assert.equal(fallback.frames.length, 1);
  const err = encodeNativeResultFromPi(args, "grep failed", true);
  let arm = 0;
  forEachField(err.frames[0]?.resultBytes ?? new Uint8Array(), (field, wire, reader) => {
    arm = field;
    skipUnknown(reader, wire, field);
  });
  assert.equal(arm, 2, "error maps to grep_result.error");
});

// ---------------------------------------------------------------------------
// Resume mcp_tools omission (PROTOCOL-AGENT §5.1, wire-verified 2026-09-29).
// ---------------------------------------------------------------------------

function irFor(tools: IrTool[]): InferenceIR {
  return {
    sessionId: "sess-native",
    systemPrompt: "sys",
    messages: [{ role: "user", text: "ping" }],
    tools,
    modelId: "composer-2.5",
    maxMode: false,
    contextWindow: 200_000,
  };
}

function resumeHandle(toolsetKey?: string): {
  conversationId: string;
  checkpoint: Uint8Array;
  fingerprint: string;
  blobs: { idHex: string; data: Uint8Array }[];
  toolsetKey?: string;
} {
  return {
    conversationId: "conv-1",
    checkpoint: encodeFields((w) => writeBytes(w, 1, new Uint8Array(32).fill(1))),
    fingerprint: "fp",
    blobs: [],
    ...(toolsetKey !== undefined ? { toolsetKey } : {}),
  };
}

/** Field numbers of the AgentRunRequest (nested in AgentClientMessage field 1). */
function requestFields(bytes: Uint8Array): number[] {
  const fields: number[] = [];
  forEachField(bytes, (field, wire, reader) => {
    if (field !== 1) {
      skipUnknown(reader, wire, field);
      return;
    }
    forEachField(expectBytes(reader, wire), (f, w, r) => {
      fields.push(f);
      skipUnknown(r, w, f);
    });
  });
  return fields;
}

test("T-NATIVE: resume omits mcp_tools when the tool set is unchanged, re-sends on change", () => {
  const tools = [tool("ctx_shell", "Run a shell command", { command: { type: "string" } })];
  const same = buildAgentRequest(irFor(tools), undefined, resumeHandle("ctx_shell"));
  assert.equal(requestFields(same.bytes).includes(4), false, "unchanged set: omit field 4");

  const changed = buildAgentRequest(irFor([...tools, readTool]), undefined, resumeHandle("ctx_shell"));
  assert.equal(requestFields(changed.bytes).includes(4), true, "changed set: re-send field 4");

  const legacy = buildAgentRequest(irFor(tools), undefined, resumeHandle());
  assert.equal(requestFields(legacy.bytes).includes(4), true, "handle without toolsetKey: re-send");

  const fresh = buildAgentRequest(irFor(tools));
  assert.equal(requestFields(fresh.bytes).includes(4), true, "fresh conversation always sends");

  const prev = process.env.CURSOR_PROVIDER_RESEND_MCP_ON_RESUME;
  process.env.CURSOR_PROVIDER_RESEND_MCP_ON_RESUME = "1";
  try {
    const forced = buildAgentRequest(irFor(tools), undefined, resumeHandle("ctx_shell"));
    assert.equal(requestFields(forced.bytes).includes(4), true, "env escape hatch re-sends");
  } finally {
    if (prev === undefined) delete process.env.CURSOR_PROVIDER_RESEND_MCP_ON_RESUME;
    else process.env.CURSOR_PROVIDER_RESEND_MCP_ON_RESUME = prev;
  }
});

const codeMode = tool(
  "codemode",
  "Run JavaScript that calls bash, shell, read, write, grep, and find tools",
  { code: { type: "string" } },
  ["code"],
);

test("T-NATIVE: Glob skips ls, which has no pattern, and returns a file list", () => {
  const ls = tool("ls", "List directory contents", { path: { type: "string" }, limit: { type: "number" } });
  const find = tool("find", "Find files by glob pattern", { pattern: { type: "string" }, path: { type: "string" } });
  const args: NativeArgs = {
    case: "grepArgs",
    pattern: "",
    glob: "**/SKILL.md",
    path: "/skills",
    caseInsensitive: false,
    outputMode: "content",
  };
  const hit = translateNativeToPi(args, [ls, find, codeMode]);
  assert.equal(hit?.tool.name, "find");
  assert.deepEqual(hit?.args, { pattern: "**/SKILL.md", path: "/skills" });

  const reply = encodeNativeResultFromPi(args, "buddycli/SKILL.md\nwecom/SKILL.md\n", false);
  const bytes = Buffer.from(reply.frames[0]?.resultBytes ?? new Uint8Array());
  assert.ok(bytes.includes("files_with_matches"));
  assert.ok(bytes.includes("buddycli/SKILL.md"));
  assert.ok(!bytes.includes("Script completed"));

  const wrapped = JSON.stringify([
    { type: "text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n" },
    { type: "text", text: "buddycli/SKILL.md\nwecom/SKILL.md\n" },
  ]);
  const wrappedReply = encodeNativeResultFromPi(args, wrapped, false);
  const wrappedBytes = Buffer.from(wrappedReply.frames[0]?.resultBytes ?? new Uint8Array());
  assert.ok(wrappedBytes.includes("buddycli/SKILL.md"));
  assert.ok(!wrappedBytes.includes("Script completed"));

  const failed = encodeNativeResultFromPi(
    args,
    "Script failed\nWall time 0.0 seconds\nOutput:\nno find-capable tool",
    false,
  );
  let arm = 0;
  forEachField(failed.frames[0]?.resultBytes ?? new Uint8Array(), (field, wire, reader) => {
    arm = field;
    skipUnknown(reader, wire, field);
  });
  assert.equal(arm, 2, "a failed glob script stays on the error arm");
});

test("T-NATIVE: declared bash wins over codemode; only-mode synthesizes a { code } script", () => {
  const args: NativeArgs = { case: "shellArgs", command: "echo hi", workingDirectory: "/tmp", timeoutMs: 0 };
  const both = translateNativeToPi(args, [ctxShell, codeMode]);
  assert.equal(both?.tool.name, "ctx_shell");
  assert.equal("code" in (both?.args ?? {}), false);
  assert.equal(matchToolFor("shellArgs", [codeMode]), undefined, "codemode never matches as a command tool");

  const only = translateNativeToPi(args, [codeMode]);
  assert.equal(only?.tool.name, "codemode");
  const script = String(only?.args.code);
  assert.match(script, /\["bash","ctx_shell","shell","exec"\]/, "executor is resolved at runtime, never hardcoded");
  assert.match(script, /ALL_TOOLS/, "a missing executor fails listing the full tool roster");
  assert.match(script, /cd -- '\/tmp' && echo hi/);

  const read = translateNativeToPi({ case: "readArgs", path: "a.txt" }, [codeMode]);
  assert.equal(read?.tool.name, "codemode");
  assert.match(String(read?.args.code), /\["read","ctx_read"\]/);
  assert.match(String(read?.args.code), /\{ path: "a\.txt" \}/);

  const write = translateNativeToPi({ case: "writeArgs", path: "b.txt", contents: "body" }, [codeMode]);
  assert.match(String(write?.args.code), /\["write","ctx_write"\]/);

  const del = translateNativeToPi({ case: "deleteArgs", path: "gone.txt" }, [codeMode]);
  assert.match(String(del?.args.code), /\["bash","ctx_shell"/);
  assert.match(String(del?.args.code), /D0:%s/);

  const grep = translateNativeToPi(
    { case: "grepArgs", pattern: "needle", glob: "*.ts", path: "/src", caseInsensitive: true, outputMode: "content" },
    [codeMode],
  );
  assert.match(String(grep?.args.code), /\["grep","ctx_grep","ffgrep"\]/);
  assert.match(String(grep?.args.code), /ignoreCase/);

  const glob = translateNativeToPi(
    { case: "grepArgs", pattern: "", glob: "**/*.ts", path: "/src", caseInsensitive: false, outputMode: "files_with_matches" },
    [codeMode],
  );
  assert.match(String(glob?.args.code), /\["find","fffind","ctx_find"\]/);
});

test("T-NATIVE: synthesized scripts pick a replacement tool when the builtin is absent", async () => {
  // Reproduces the live pi 1.1.0 + lean-ctx failure: tools.bash is gone from the
  // codemode sandbox; the script must fall back to ctx_shell, and must fail with
  // the tool roster when no candidate exists.
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...fnArgs: unknown[]) => Promise<unknown>;
  // The real codemode sandbox exposes `tools` as a proxy that THROWS on missing
  // members (pi 1.1.0 QuickJS bridge); replicate that so the test catches probes
  // that only work with plain objects.
  const throwingTools = (impl: Record<string, unknown>): Record<string, unknown> =>
    new Proxy(impl, {
      get(target, prop) {
        if (typeof prop === "string" && !(prop in target)) throw new TypeError(`tools.${prop} does not exist`);
        return Reflect.get(target, prop);
      },
    });
  const runScript = async (script: string, tools: Record<string, unknown>): Promise<string> => {
    const out: string[] = [];
    const fn = new AsyncFunction("tools", "ALL_TOOLS", "text", "exit", script);
    await fn(
      throwingTools(tools),
      [{ name: "ctx_shell" }],
      (v: unknown) => out.push(String(v)),
      (code?: number) => {
        if (code) throw new Error(`exit ${code}`);
      },
    );
    return out.join("");
  };

  const shell = translateNativeToPi({ case: "shellArgs", command: "echo hi", workingDirectory: "", timeoutMs: 0 }, [codeMode]);
  const shellText = await runScript(String(shell?.args.code), {
    ctx_shell: async ({ command }: { command: string }) => ({ output: `ran: ${command}`, exit_code: 0 }),
  });
  assert.equal(shellText, "ran: echo hi");

  await assert.rejects(
    runScript(String(shell?.args.code), {}),
    /no bash-capable tool.*available: ctx_shell/,
    "no candidate -> error names the available tools",
  );

  const read = translateNativeToPi({ case: "readArgs", path: "a.txt" }, [codeMode]);
  const readText = await runScript(String(read?.args.code), {
    ctx_read: async ({ path }: { path: string }) => `content of ${path}`,
  });
  assert.equal(readText, "content of a.txt");

  const grep = translateNativeToPi(
    { case: "grepArgs", pattern: "needle", glob: "", path: "", caseInsensitive: false, outputMode: "content" },
    [codeMode],
  );
  const grepText = await runScript(String(grep?.args.code), {
    ffgrep: async ({ pattern }: { pattern: string }) => `hit: ${pattern}`,
  });
  assert.equal(grepText, "hit: needle");
});

test("T-NATIVE: unwrapCodemodeResult strips the script header and marks failed scripts", () => {
  const ok = unwrapCodemodeResult("Script completed\nWall time 0.1 seconds\nOutput:\nhi\n", false);
  assert.equal(ok.text, "hi\n");
  assert.equal(ok.isError, false);
  const fail = unwrapCodemodeResult("Script failed\nWall time 1.2 seconds\nOutput:\nboom", false);
  assert.equal(fail.text, "boom");
  assert.equal(fail.isError, true);
  const plain = unwrapCodemodeResult("hi\n", false);
  assert.deepEqual(plain, { text: "hi\n", isError: false });

  const args: NativeArgs = { case: "shellArgs", command: "echo hi", workingDirectory: "", timeoutMs: 0 };
  const reply = encodeNativeResultFromPi(args, "Script completed\nWall time 0.1 seconds\nOutput:\nhi\n", false);
  let stdout = "";
  forEachField(reply.frames[0]?.resultBytes ?? new Uint8Array(), (field, wire, reader) => {
    if (field === 1) {
      forEachField(expectBytes(reader, wire), (f2, w2, r2) => {
        if (f2 === 5) stdout = expectString(r2, w2);
        else skipUnknown(r2, w2, f2);
      });
    } else skipUnknown(reader, wire, field);
  });
  assert.equal(stdout, "hi\n");

  const bad = encodeNativeResultFromPi(args, "Script failed\nWall time 0.0 seconds\nOutput:\nboom", false);
  let arm = 0;
  forEachField(bad.frames[0]?.resultBytes ?? new Uint8Array(), (field, wire, reader) => {
    arm = field;
    skipUnknown(reader, wire, field);
  });
  assert.equal(arm, 2, "failed script header maps to the native error arm");
});

test("T-NATIVE: read of a missing file returns clean not-found guidance, other errors pass through", () => {
  // Live-found (composer-2.5, pi 1.1.0): a raw ENOENT text containing the word
  // access made the model blame sandboxing and retry Read instead of Writing.
  const guidance = readFailureText("main.c", "Script error:\nError: ENOENT: no such file or directory, access '/x/main.c'");
  assert.match(guidance, /File does not exist: main\.c/);
  assert.match(guidance, /Write tool/);
  assert.ok(!/access|ENOENT/.test(guidance), "raw error noise must not leak");

  const other = readFailureText("main.c", "permission denied: main.c");
  assert.equal(other, "permission denied: main.c", "non-not-found errors pass through verbatim");

  // A looser not-found text keeps the guidance on the error arm.
  const reply = encodeNativeResultFromPi({ case: "readArgs", path: "main.c" }, "Error: file not found: main.c", true);
  let errText = "";
  forEachField(reply.frames[0]!.resultBytes, (f, w, r) => {
    if (f !== 2) return skipUnknown(r, w, f);
    forEachField(expectBytes(r, w), (f2, w2, r2) => {
      if (f2 === 2) errText = expectString(r2, w2);
      else skipUnknown(r2, w2, f2);
    });
  });
  assert.match(errText, /File does not exist: main\.c/);
});

test("T-NATIVE: an ENOENT read answers ReadResult.file_not_found so Cursor's Write can create the file", () => {
  // Live-found: Cursor's Write reads the target first; on the error arm it aborts and never sends writeArgs.
  for (const text of [
    "Error: ENOENT: no such file or directory, access '/tmp/new.txt'",
    "[Script error: Error: ENOENT: no such file or directory, open '/tmp/new.txt']",
  ]) {
    const reply = encodeNativeResultFromPi({ case: "readArgs", path: "/tmp/new.txt" }, text, true);
    assert.equal(reply.frames[0]?.resultField, 7);
    let arm = -1;
    let pathOut = "";
    forEachField(reply.frames[0]!.resultBytes, (f, w, r) => {
      arm = f;
      forEachField(expectBytes(r, w), (f2, w2, r2) => {
        if (f2 === 1) pathOut = expectString(r2, w2);
        else skipUnknown(r2, w2, f2);
      });
    });
    assert.equal(arm, 4, "file_not_found arm");
    assert.equal(pathOut, "/tmp/new.txt");
  }
  for (const text of ["permission denied: /tmp/new.txt", "EISDIR: illegal operation on a directory"]) {
    const reply = encodeNativeResultFromPi({ case: "readArgs", path: "/tmp/new.txt" }, text, true);
    let arm = -1;
    forEachField(reply.frames[0]!.resultBytes, (f, w, r) => {
      arm = f;
      skipUnknown(r, w, f);
    });
    assert.equal(arm, 2, "other read failures stay on the error arm");
  }
});

/** ReadResult.success (arm 1) → content + truncated flag. */
function readSuccessOf(bytes: Uint8Array): { arm: number; content: string; truncated: boolean } {
  const out = { arm: -1, content: "", truncated: false };
  forEachField(bytes, (f, w, r) => {
    out.arm = f;
    if (f !== 1) return skipUnknown(r, w, f);
    forEachField(expectBytes(r, w), (f2, w2, r2) => {
      if (f2 === 2) out.content = expectString(r2, w2);
      else if (f2 === 6) out.truncated = expectVarint(r2, w2) !== 0;
      else skipUnknown(r2, w2, f2);
    });
  });
  return out;
}

test("T-NATIVE: only Pi's trailing read notice marks a read truncated; file text never does", () => {
  // Live-found: native.ts itself contains "/\[.*truncat" — the old content-wide regex
  // flagged the read partial and Cursor refused to edit the file.
  const source = 'const re = /\\[.*truncat|\\[Showing (lines|last)/i;\n// [Showing lines 1-2 of 9. Use offset=3 to continue.] mid-file\n';
  assert.deepEqual(parseReadOutput(source), { content: source, truncated: false });
  const encoded = readSuccessOf(encodeNativeResultFromPi({ case: "readArgs", path: "a.ts" }, source, false).frames[0]!.resultBytes);
  assert.deepEqual(encoded, { arm: 1, content: source, truncated: false });

  assert.deepEqual(parseReadOutput("l1\nl2\n\n[Showing lines 1-2 of 9. Use offset=3 to continue.]"), {
    content: "l1\nl2",
    truncated: true,
    nextOffset: 3,
  });
  assert.deepEqual(parseReadOutput("l1\n\n[Showing lines 1-1 of 9 (50KB limit). Use offset=2 to continue.]"), {
    content: "l1",
    truncated: true,
    nextOffset: 2,
  });
  assert.deepEqual(parseReadOutput("l1\n\n[8 more lines in file. Use offset=2 to continue.]"), {
    content: "l1",
    truncated: true,
    nextOffset: 2,
  });
  assert.deepEqual(parseReadOutput("[Line 1 is 80KB, exceeds 50KB limit. Use bash: sed -n '1p' a | head -c 51200]"), {
    content: "",
    truncated: true,
  });
  const capped = readSuccessOf(
    encodeNativeResultFromPi({ case: "readArgs", path: "a" }, "abc\n\n[pi-cursor-provider truncated this tool result.]", false)
      .frames[0]!.resultBytes,
  );
  assert.deepEqual(capped, { arm: 1, content: "abc", truncated: true });
});

test("T-NATIVE: a Pi read that returns an image answers on ReadSuccess.data, not the text note", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const reply = encodeNativeResultFromPi({ case: "readArgs", path: "shot.png" }, "Read image file [image/png]", false, [
    { data: png, mimeType: "image/png" },
  ]);
  assert.equal(reply.frames[0]!.resultField, 7);
  const seen: { arm: number; path?: string; content?: string; data?: Uint8Array } = { arm: -1 };
  forEachField(reply.frames[0]!.resultBytes, (f, w, r) => {
    seen.arm = f;
    if (f !== 1) return skipUnknown(r, w, f);
    forEachField(expectBytes(r, w), (f2, w2, r2) => {
      if (f2 === 1) seen.path = expectString(r2, w2);
      else if (f2 === 2) seen.content = expectString(r2, w2);
      else if (f2 === 5) seen.data = expectBytes(r2, w2);
      else skipUnknown(r2, w2, f2);
    });
  });
  assert.equal(seen.arm, 1);
  assert.equal(seen.path, "shot.png");
  assert.equal(seen.content, undefined, "content and data share the output oneof");
  assert.deepEqual(seen.data, png);
});
