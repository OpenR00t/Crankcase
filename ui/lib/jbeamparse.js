// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Crankcase contributors
//
// A tolerant reader for JBeam, the JSON dialect BeamNG.drive uses for vehicles.
// On top of JSON it allows // and /* */ comments, trailing commas, and missing
// commas between values or key/value pairs (all common in real files).

export function parseJBeam(text) {
  let i = 0;
  const n = text.length;
  const fail = (msg) => {
    const line = text.slice(0, i).split("\n").length;
    throw new SyntaxError(`JBeam: ${msg} at line ${line}`);
  };

  function skip() {
    while (i < n) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === ",") { i++; continue; }
      if (c === "/" && text[i + 1] === "/") { while (i < n && text[i] !== "\n") i++; continue; }
      if (c === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        i = end < 0 ? n : end + 2;
        continue;
      }
      break;
    }
  }

  function string() {
    let out = "";
    i++; // opening quote
    while (i < n) {
      const c = text[i++];
      if (c === '"') return out;
      if (c === "\\") {
        const e = text[i++];
        if (e === "n") out += "\n";
        else if (e === "t") out += "\t";
        else if (e === "u") { out += String.fromCharCode(parseInt(text.slice(i, i + 4), 16)); i += 4; }
        else out += e;
      } else out += c;
    }
    fail("unterminated string");
  }

  function bare() {
    const start = i;
    while (i < n && !/[\s,:\[\]{}"\/]/.test(text[i])) i++;
    const word = text.slice(start, i);
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    const num = Number(word);
    if (word !== "" && !Number.isNaN(num)) return num;
    if (word === "") fail(`unexpected '${text[i]}'`);
    return word; // e.g. FLT_MAX written without quotes
  }

  function value() {
    skip();
    const c = text[i];
    if (c === "{") return object();
    if (c === "[") return array();
    if (c === '"') return string();
    return bare();
  }

  function object() {
    i++;
    const out = {};
    for (;;) {
      skip();
      if (i >= n) fail("unterminated object");
      if (text[i] === "}") { i++; return out; }
      const key = text[i] === '"' ? string() : String(bare());
      skip();
      if (text[i] !== ":") fail(`expected ':' after "${key}"`);
      i++;
      out[key] = value();
    }
  }

  function array() {
    i++;
    const out = [];
    for (;;) {
      skip();
      if (i >= n) fail("unterminated array");
      if (text[i] === "]") { i++; return out; }
      out.push(value());
    }
  }

  const result = value();
  skip();
  return result;
}

/** Write a JBeam file: valid JSON, short arrays and objects kept on one line like BeamNG's own files. */
export function writeJBeam(obj, header = "") {
  const inline = (v) => JSON.stringify(v).replace(/,(?=["\[{\-\d tfn])/g, ", ").replace(/":/g, '": ');
  const fmt = (v, indent) => {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    const flat = inline(v);
    if (flat.length + indent.length <= 120 && (Array.isArray(v) || Object.keys(v).length <= 4)) return flat;
    const inner = indent + "  ";
    if (Array.isArray(v)) {
      return `[\n${v.map((x) => inner + fmt(x, inner)).join(",\n")}\n${indent}]`;
    }
    return `{\n${Object.entries(v).map(([k, x]) => `${inner}${JSON.stringify(k)}: ${fmt(x, inner)}`).join(",\n")}\n${indent}}`;
  };
  return `${header ? header + "\n" : ""}${fmt(obj, "")}\n`;
}
