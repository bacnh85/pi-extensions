/**
 * str-replace-editor.ts — faithful port of DeepSeek Harness' Minimal-pair
 * `str_replace_editor` tool (packages/fs/tool-str-replace-editor, commit
 * 47f9438, MIT). Byte-faithful name, description, and schema — the tool
 * schema is the decisive anchor lever for DeepSeek v4 Pro (dsh-anchored-
 * standard issue #11: the real Minimal pair anchored "we need…" 5/5; every
 * read/pwsh substitution produced standard-like first lines 11/11).
 *
 * Implemented over Node fs; relative paths resolve against the call's cwd.
 */

import { readFile, writeFile, stat, readdir, mkdir } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath, dirname } from "node:path";
import { homedir } from "node:os";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TRUNCATED_MESSAGE =
  "To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.";

const MAX_OUTPUT_CHARS = 16_000;

// Byte-copy of DSH's DEFAULT_DESCRIPTION (trimmed template literal).
const EDITOR_DESCRIPTION = `Custom editing tool for viewing, creating and editing files
* State is persistent across command calls and discussions with the user
* If \`path\` is a file, \`view\` displays the result of applying \`cat -n\`. If \`path\` is a directory, \`view\` lists non-hidden files and directories up to 2 levels deep
* The \`create\` command cannot be used if the specified \`path\` already exists as a file
* If a \`command\` generates a long output, it will be truncated and marked with \`\`\`

Notes for using the \`str_replace\` command:
* The \`old_str\` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!
* If the \`old_str\` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in \`old_str\` to make it unique
* The \`new_str\` parameter should contain the edited lines that should replace the \`old_str\``;

function maybeTruncate(content: string): string {
  return content.length <= MAX_OUTPUT_CHARS ? content : content.slice(0, MAX_OUTPUT_CHARS) + TRUNCATED_MESSAGE;
}

function matchOffsets(content: string, search: string): number[] {
  const offsets: number[] = [];
  let offset = 0;
  while (true) {
    const match = content.indexOf(search, offset);
    if (match < 0) return offsets;
    offsets.push(match);
    offset = match + search.length;
  }
}

function lineNumbersAt(content: string, offsets: readonly number[]): number[] {
  let line = 1;
  let cursor = 0;
  return offsets.map((offset) => {
    while (cursor < offset) {
      if (content[cursor] === "\n") line += 1;
      cursor += 1;
    }
    return line;
  });
}

function formatFileView(path: string, content: string, viewRange?: number[]): string {
  const allLines = content.split("\n");
  let lines = allLines;
  let initialLine = 1;
  let finalLine: number | undefined;
  let prompt = `Here's the content of ${path} with line numbers (which has a total of ${allLines.length} lines)`;
  if (viewRange !== undefined) {
    const [requestedInitialLine, requestedFinalLine] = viewRange;
    if (viewRange.length !== 2 || !viewRange.every(Number.isInteger)) {
      throw new Error("Invalid `view_range`. It should be a list of two integers.");
    }
    initialLine = requestedInitialLine;
    finalLine = requestedFinalLine;
    if (initialLine < 1 || initialLine > allLines.length) {
      throw new Error(`Invalid \`view_range\`: [${viewRange.join(", ")}]. Its first element \`${initialLine}\` should be within the range of lines of the file: [1, ${allLines.length}]`);
    }
    if (finalLine > allLines.length) {
      throw new Error(`Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${finalLine}\` should be smaller than the number of lines in the file: \`${allLines.length}\``);
    }
    if (finalLine !== -1 && finalLine < initialLine) {
      throw new Error(`Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${finalLine}\` should be larger or equal than its first \`${initialLine}\``);
    }
    lines = finalLine === -1 ? allLines.slice(initialLine - 1) : allLines.slice(initialLine - 1, finalLine);
    prompt += ` with view_range=[${initialLine}, ${finalLine}]`;
  }
  const numbered = lines.map((line, index) => `${String(initialLine + index).padStart(6, " ")} ${line}`).join("\n");
  return maybeTruncate(`${prompt}:\n${numbered}\n`);
}

async function listDirectory(dirPath: string): Promise<string> {
  async function visit(dir: string, depth: number): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const rows: string[] = [];
    for (const entry of entries.filter(
      (candidate) => !candidate.name.startsWith(".") && candidate.name !== "node_modules" && candidate.name !== "__pycache__",
    )) {
      const type = entry.isDirectory() ? "d" : entry.isFile() ? "f" : "?";
      const full = resolvePath(dir, entry.name);
      rows.push(`${type}\t${full}`);
      if (entry.isDirectory() && depth < 2) {
        rows.push(...(await visit(full, depth + 1)));
      }
    }
    return rows;
  }
  const rows = [`d\t${dirPath}`, ...(await visit(dirPath, 1))];
  rows.sort((left, right) => {
    const leftPath = left.slice(left.indexOf("\t") + 1);
    const rightPath = right.slice(right.indexOf("\t") + 1);
    return leftPath < rightPath ? -1 : 1;
  });
  const listing = maybeTruncate(rows.join("\n") + "\n");
  return `Here're the files and directories up to 2 levels deep in ${dirPath}, excluding hidden items, node_modules, and Python cache directories:\n${listing}\n`;
}

function resolveTarget(cwd: string, path: string): string {
  if (typeof path !== "string" || path.trim().length === 0) throw new Error("path must be a non-empty string");
  // ~/… expands to the home dir, matching Pi's built-in file tools (models
  // trained on DSH emit absolute paths; relative ones resolve against cwd).
  const expanded =
    path === "~" ? homedir() : path.startsWith("~/") || path.startsWith("~\\") ? `${homedir()}${path.slice(1)}` : path;
  return isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
}

async function statExisting(abs: string, command: "view" | "str_replace" | "insert"): Promise<Awaited<ReturnType<typeof stat>>> {
  let info;
  try {
    info = await stat(abs);
  } catch {
    throw new Error(`The path ${abs} does not exist. Please provide a valid path.`);
  }
  if (info.isDirectory() && command !== "view") {
    throw new Error(`The path ${abs} is a directory and only the \`view\` command can be used on directories`);
  }
  return info;
}

function requiredForCommand(value: string | undefined, parameter: string, command: string, allowEmpty = true): string {
  if (value === undefined) throw new Error(`Parameter \`${parameter}\` is required for command: ${command}`);
  if (!allowEmpty && value.length === 0) throw new Error(`Parameter \`${parameter}\` is empty for command: ${command}`);
  return value;
}

async function viewPath(cwd: string, path: string, viewRange: number[] | undefined): Promise<string> {
  const abs = resolveTarget(cwd, path);
  const info = await statExisting(abs, "view");
  if (info.isDirectory()) {
    if (viewRange !== undefined) throw new Error("The `view_range` parameter is not allowed when `path` points to a directory.");
    return listDirectory(abs);
  }
  const content = await readFile(abs, "utf-8");
  return formatFileView(abs, content, viewRange);
}

async function createFile(cwd: string, path: string, fileText: string | undefined): Promise<string> {
  const content = requiredForCommand(fileText, "file_text", "create");
  const abs = resolveTarget(cwd, path);
  const existing = await stat(abs).then(() => true).catch(() => false);
  if (existing) throw new Error(`File already exists at: ${abs}. Cannot overwrite files using command \`create\`.`);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
  return `New file created successfully at: ${abs}`;
}

async function replaceInFile(cwd: string, path: string, oldStr: string | undefined, newStr: string | undefined): Promise<string> {
  const oldValue = requiredForCommand(oldStr, "old_str", "str_replace", false);
  const newValue = newStr ?? "";
  const abs = resolveTarget(cwd, path);
  await statExisting(abs, "str_replace");
  const before = await readFile(abs, "utf-8");
  const offsets = matchOffsets(before, oldValue);
  const offset = offsets[0];
  if (offset === undefined) {
    throw new Error(`No replacement was performed, old_str \`${oldValue}\` did not appear verbatim in ${abs}.`);
  }
  if (offsets.length > 1) {
    const lines = lineNumbersAt(before, offsets);
    throw new Error(`No replacement was performed. Multiple occurrences of old_str \`${oldValue}\` in lines [${lines.join(", ")}]. Please ensure it is unique`);
  }
  await writeFile(abs, before.slice(0, offset) + newValue + before.slice(offset + oldValue.length));
  return `The file ${abs} has been edited successfully.`;
}

async function insertInFile(cwd: string, path: string, insertLine: number | undefined, newStr: string | undefined): Promise<string> {
  if (insertLine === undefined) throw new Error("Parameter `insert_line` is required for command: insert");
  const value = requiredForCommand(newStr, "new_str", "insert");
  const abs = resolveTarget(cwd, path);
  await statExisting(abs, "insert");
  const before = await readFile(abs, "utf-8");
  const lines = before.split("\n");
  if (!Number.isInteger(insertLine) || insertLine < 0 || insertLine > lines.length) {
    throw new Error(`Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${lines.length}]`);
  }
  const after = [...lines.slice(0, insertLine), ...value.split("\n"), ...lines.slice(insertLine)].join("\n");
  await writeFile(abs, after);
  return `The file ${abs} has been edited successfully.`;
}

/** Tool definition factory mirroring DSH's `str_replace_editor` (Minimal pair). */
export function createStrReplaceEditorToolDefinition(cwd: string) {
  return defineTool({
    name: "str_replace_editor",
    label: "str_replace_editor",
    description: EDITOR_DESCRIPTION,
    promptSnippet: "View, create, edit, or insert into files (view/create/str_replace/insert over absolute paths)",
    parameters: Type.Object({
      command: Type.Enum({
        view: "view",
        create: "create",
        str_replace: "str_replace",
        insert: "insert",
      }),
      path: Type.String({ description: "Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`." }),
      file_text: Type.Optional(Type.String({ description: "Required parameter of `create` command, with the content of the file to be created." })),
      insert_line: Type.Optional(Type.Number({ description: "Required parameter of `insert` command. The `new_str` will be inserted AFTER the line `insert_line` of `path`." })),
      new_str: Type.Optional(Type.String({ description: "Optional parameter of `str_replace` command containing the new string (if not given, no string will be added). Required parameter of `insert` command containing the string to insert." })),
      old_str: Type.Optional(Type.String({ description: "Required parameter of `str_replace` command containing the string in `path` to replace." })),
      view_range: Type.Optional(Type.Array(Type.Number(), { description: "Optional parameter of `view` command when `path` points to a file. If none is given, the full file is shown. If provided, the file will be shown in the indicated line number range, e.g. [11, 12] will show lines 11 and 12. Indexing at 1 to start. Setting `[start_line, -1]` shows all lines from `start_line` to the end of the file." })),
    }),
    renderShell: "self",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const callCwd = ctx?.cwd || cwd;
      try {
        let text: string;
        switch (params.command) {
          case "view":
            text = await viewPath(callCwd, params.path, params.view_range);
            break;
          case "create":
            text = await createFile(callCwd, params.path, params.file_text);
            break;
          case "str_replace":
            text = await replaceInFile(callCwd, params.path, params.old_str, params.new_str);
            break;
          case "insert":
            text = await insertInFile(callCwd, params.path, params.insert_line, params.new_str);
            break;
          default:
            throw new Error(`Unknown command: ${String(params.command)}`);
        }
        return { content: [{ type: "text", text }], details: undefined };
      } catch (err) {
        return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true, details: undefined };
      }
    },
  });
}
