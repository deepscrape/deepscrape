// One-off: rewrap the over-long COMMENT lines that `max-len` reports.
//
// Scope is deliberately narrow. It only rewrites lines whose first non-space
// characters are `//` or `*`, so it cannot touch code, cannot break a string, and
// cannot reflow a one-line `/** ... */` block. Code lines are left alone because
// wrapping them needs judgement per site and a wrong break is a syntax error.
//
// Usage: bun scripts/rewrap-comments.mjs <eslint-unix-output.txt>
// The input is eslint's `-f unix` format: path:line:col: message [rule].
import { readFileSync, writeFileSync } from "node:fs"

const LIMIT = 80
const lintReport = process.argv[2]

if (!lintReport) {
  console.error("usage: bun scripts/rewrap-comments.mjs <eslint-unix-output.txt>")
  process.exit(2)
}

/** file -> descending line numbers that max-len flagged */
const targets = new Map()

for (const raw of readFileSync(lintReport, "utf8").split("\n")) {
  if (!raw.includes("max-len")) {
    continue
  }
  // Lazy prefix so a Windows drive letter (`D:\`) does not terminate the match.
  const match = /^(.*?):(\d+):\d+:/.exec(raw)
  if (!match) {
    continue
  }
  const [, file, lineNumber] = match
  if (!targets.has(file)) {
    targets.set(file, [])
  }
  targets.get(file).push(Number(lineNumber))
}

const wrap = (line) => {
  // `[^\r]*` rather than `.*`: on a CRLF file the line still ends in `\r` after
  // `split("\n")`, and JS `.` does not match a carriage return, so `(.*)$` would
  // match nothing at all and every comment would be silently skipped.
  const match = /^(\s*)(\/\/|\*)\s?([^\r]*)\r?$/.exec(line)
  if (!match) {
    return null // not a comment interior — leave it to a human
  }

  const [, indent, marker, text] = match
  const prefix = `${indent}${marker === "*" ? "* " : "// "}`
  if (prefix.length >= LIMIT) {
    return null
  }

  const words = text.trim().split(/\s+/)
  const out = []
  let current = ""
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (prefix.length + candidate.length <= LIMIT) {
      current = candidate
    } else {
      if (current) {
        out.push(current)
      }
      current = word
    }
  }
  if (current) {
    out.push(current)
  }

  return out.map((chunk) => `${prefix}${chunk}`.replace(/\s+$/, ""))
}

let filesChanged = 0
let commentsRewrapped = 0
let skipped = 0

for (const [file, lines] of targets) {
  const original = readFileSync(file, "utf8")
  const eol = original.includes("\r\n") ? "\r" : ""
  const rows = original.split("\n")

  // Descending, so replacing one line with several cannot shift a later index.
  for (const lineNumber of lines.sort((a, b) => b - a)) {
    const current = rows[lineNumber - 1]
    if (current === undefined || current.length <= LIMIT) {
      continue
    }
    const wrapped = wrap(current)
    if (!wrapped) {
      skipped += 1
      continue
    }
    if (eol) {
      for (let i = 0; i < wrapped.length; i += 1) {
        wrapped[i] += eol
      }
    }
    rows.splice(lineNumber - 1, 1, ...wrapped)
    commentsRewrapped += 1
  }

  const updated = rows.join("\n")
  if (updated !== original) {
    writeFileSync(file, updated, "utf8")
    filesChanged += 1
  }
}

console.log(
  `${filesChanged} files changed, ${commentsRewrapped} comments rewrapped, ` +
  `${skipped} non-comment lines left alone`,
)
