// CSV for the lead lists (RFC 4180): reading an uploaded file and writing an export. Spreadsheet programs run any cell that starts with
// = + - @ as a formula, so exported cells that could be read that way get a leading apostrophe (the import takes it off again).
import { AppError } from "../errors.js";

export const CSV_BOM = "﻿";
const DELIMITERS = [",", ";", "\t", "|"] as const;
const MAX_COLUMNS = 256;

/** The delimiter a file uses: the one that appears most in its first line outside quotes (comma when nothing decides). */
export function detectDelimiter(text: string): string {
  const counts = new Map<string, number>(DELIMITERS.map((delimiter) => [delimiter, 0]));
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === '"') { quoted = !quoted; continue; }
    if (!quoted && (char === "\n" || char === "\r")) break;
    if (!quoted && counts.has(char)) counts.set(char, counts.get(char)! + 1);
  }
  let best = ",";
  let most = 0;
  for (const [delimiter, count] of counts) if (count > most) { best = delimiter; most = count; }
  return best;
}

/**
 * Reads CSV text into rows of cells. Handles a leading byte order mark, CRLF, LF or CR line ends, quoted cells with doubled quotes and
 * line breaks inside quotes. Rows with no content at all are dropped. A quote that never closes is an error (the file is damaged).
 */
export function parseCsv(input: string, delimiter = detectDelimiter(input)): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let started = false;
  const endCell = () => { row.push(cell); cell = ""; if (row.length > MAX_COLUMNS) throw new AppError(400, "BAD_REQUEST", `The file has more than ${MAX_COLUMNS} columns: is it a CSV?`); };
  const endRow = () => { endCell(); if (row.some((value) => value.trim() !== "")) rows.push(row); row = []; started = false; };
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') { if (text[index + 1] === '"') { cell += '"'; index++; } else quoted = false; }
      else cell += char;
      continue;
    }
    if (char === '"' && !started) { quoted = true; started = true; continue; }
    if (char === delimiter) { endCell(); started = false; continue; }
    if (char === "\r" || char === "\n") { if (char === "\r" && text[index + 1] === "\n") index++; endRow(); continue; }
    cell += char;
    started = true;
  }
  if (quoted) throw new AppError(400, "BAD_REQUEST", `The file has a quote that never closes, near row ${rows.length + 1}: check it in a spreadsheet and save it as CSV again`);
  if (cell !== "" || row.length > 0) endRow();
  return rows;
}

/**
 * Cells a spreadsheet could read as a formula: = + - @ (phone numbers too: "+1-202-555-0143" would be worked out as a sum), tab and
 * carriage return, the full-width ＝ ＋ － ＠, and anything that starts with a space, a no-break space or a zero-width character (some
 * programs skip those before deciding).
 */
const FORMULA_START = /^[=+\-@\t\r \u00a0\u1680\u2000-\u200f\u2028\u2029\u202f\u205f\u2060-\u2064\u3000\ufeff\uff0b\uff0d\uff1d\uff20]/;

/** One cell for a CSV file: quoted when it holds a comma, quote or line break (quotes doubled), and defused when a spreadsheet would run it. */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const csvRow = (values: unknown[]) => values.map(csvCell).join(",");
