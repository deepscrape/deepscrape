/**
 * Generate the JSDoc blocks that `eslint-config-google` requires across the
 * backend (`functions/src` and `bff`).
 *
 * Why a generator: `require-jsdoc` wants a block on every function declaration,
 * class method and class; `valid-jsdoc` then validates what is there. 40 modules
 * had opted out with blanket disables, so the rules were never in force. Writing
 * several hundred blocks by hand is unverifiable; this is re-runnable and
 * idempotent (already-documented nodes are skipped).
 *
 * Usage: bun scripts/generate-jsdoc.mjs [--dry]
 *
 * Param types are `*` on purpose: valid-jsdoc validates types against a fixed
 * Closure whitelist, which rejects TS type names (`Record<string, unknown>`,
 * `Request`, unions). `*` is always accepted and never lies about the shape.
 * Deliberate ceiling — if you want real types, `@param {string} uid` hand-written
 * for the functions that matter, not machine-guessed.
 *
 * The summary line is the identifier alone. That is a stub, not documentation:
 * replace it with the *why* when you next touch the function, the way
 * callable-limiter.ts and bff/bridge.ts already do.
 */

import {readFileSync, readdirSync, statSync, writeFileSync} from "node:fs"
import {extname, join, relative} from "node:path"
import ts from "typescript"

const DRY = process.argv.includes("--dry")
const roots = ["functions/src", "bff"]
const skipDirs = new Set(["node_modules", "lib", "dist", "generated"])

/** Lines the previous policy needed, now redundant. */
const DISABLE_LINES = [
  "/* eslint-disable require-jsdoc */",
  "/* eslint-disable valid-jsdoc */",
]

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)

    if (statSync(full).isDirectory()) {
      if (!skipDirs.has(entry)) walk(full, out)
    } else if (extname(entry) === ".ts" && !entry.endsWith(".d.ts")) {
      // .d.ts are ambient type shims (ua-parser-bot.d.ts): eslint does not ask
      // for docs there, so adding them is noise in a vendored declaration.
      out.push(full)
    }
  }

  return out
}

/** Does the AST node kinds require-jsdoc targets? */
const needsDoc = (node) =>
  ts.isFunctionDeclaration(node) ||
  ts.isMethodDeclaration(node) ||
  // ESTree reports a constructor as a MethodDefinition, so the rule requires a
  // block here even though TS models it as its own node kind.
  ts.isConstructorDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node) ||
  ts.isClassDeclaration(node)

/**
 * Parameters valid-jsdoc will insist on seeing documented.
 *
 * Only plain identifiers. The rule explicitly skips the rest:
 * "TODO(nzakas): Figure out logical things to do with destructured, default,
 * rest params" -- it resolves AssignmentPattern to its left side and then only
 * inspects `Identifier` params, so documenting a pattern by an invented name
 * yields "documented but not found" instead of satisfying anything.
 */
const documentedParams = (node) =>
  (node.parameters ?? [])
    .filter((param) => ts.isIdentifier(param.name))
    .map((param) => param.name.text)

/** Is the function declared async? */
const isAsync = (node) =>
  Boolean(node.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.AsyncKeyword))

/** Does the body return a value? Nested functions are not our return. */
const hasValueReturn = (node) => {
  // A concise arrow body (`(a) => a + 1`) returns its expression implicitly and
  // the rule counts that as a return the block has to document.
  if (node.body && !ts.isBlock(node.body)) return true

  let found = false

  const walk = (child) => {
    if (found) return

    if (ts.isReturnStatement(child) && child.expression) {
      found = true
      return
    }

    if (child !== node && (ts.isFunctionLike(child) || ts.isClassLike(child))) return

    ts.forEachChild(child, walk)
  }

  if (node.body) walk(node.body)

  return found
}

/**
 * valid-jsdoc wants an @return when a non-async function returns a value
 * (`requireReturn || (functionData.returnPresent && !node.async)`), and reports
 * "Unexpected @return tag" when one appears on a void function. Getters,
 * setters, constructors and classes are exempt on the rule's own terms.
 */
const needsReturn = (node) =>
  !isAsync(node) &&
  !ts.isGetAccessorDeclaration(node) &&
  !ts.isSetAccessorDeclaration(node) &&
  !ts.isConstructorDeclaration(node) &&
  hasValueReturn(node)

/** The tags this generator owns the shape of. */
const generatedTags = (node, indent) => [
  ...documentedParams(node).map((param) => `${indent} * @param {*} ${param}`),
  ...(needsReturn(node) ? [`${indent} * @return {*}`] : []),
]

const blockFor = (node, indent) =>
  [
    `${indent}/**`,
    `${indent} * ${labelFor(node)}`,
    ...generatedTags(node, indent),
    `${indent} */`,
  ]

/** True when a block contains nothing but what this generator would emit. */
const isGeneratedBlock = (blockLines) =>
  blockLines.every((line) => {
    const body = line.trim().replace(/^\/\*\*$|^\*\/$/, "").replace(/^\*/, "").trim()

    return (
      line.trim() === "/**" ||
      line.trim() === "*/" ||
      /^[\w$]+$/.test(body) ||
      /^@param \{\*\} [\w$]+$/.test(body) ||
      body === "@return {*}"
    )
  })

/** Readable summary for an anonymous callback: its route path, else "callback". */
const labelFor = (node) => {
  if (node.name) return node.name.getText()

  const call = node.parent && ts.isCallExpression(node.parent) ? node.parent : null
  const route = call?.arguments.find((arg) => ts.isStringLiteralLike(arg))

  return route ? route.text : "callback"
}

/**
 * Function expressions reachable from a variable statement or class property.
 *
 * require-jsdoc does not require a block for these (only FunctionDeclaration /
 * MethodDefinition / ClassDeclaration), but valid-jsdoc still validates any block
 * that sits above them -- so an incomplete hand-written block fails the gate.
 * These are completed, never created.
 */
const functionIn = (node) => {
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations
      .map((decl) => decl.initializer)
      .filter((init) => init && ts.isFunctionLike(init))
  }

  if (ts.isPropertyDeclaration(node) && node.initializer && ts.isFunctionLike(node.initializer)) {
    return [node.initializer]
  }

  return []
}

const processFile = (file) => {
  const original = readFileSync(file, "utf8")
  const source = ts.createSourceFile(file, original, ts.ScriptTarget.Latest, true)
  const lines = original.split("\n")
  const edits = []
  let created = 0
  let completed = 0

  const lineOf = (pos) => source.getLineAndCharacterOfPosition(pos).line
  const indentAt = (pos) => {
    const start = source.text.lastIndexOf("\n", pos - 1) + 1

    return source.text.slice(start, pos).match(/^[ \t]*/)[0]
  }

  const planEdit = (host, fns, create) => {
    const start = host.getStart(source)
    const indent = indentAt(start)
    const leading = ts.getLeadingCommentRanges(source.text, host.getFullStart()) ?? []
    const last = leading[leading.length - 1]
    const hasBlock = Boolean(
      last &&
        last.kind === ts.SyntaxKind.MultiLineCommentTrivia &&
        source.text.startsWith("/**", last.pos),
    )

    if (!hasBlock) {
      if (!create) return

      const line = lineOf(start)

      // A node sharing its line with code before it cannot own a leading block:
      // inserting above the line attaches the comment to the PREVIOUS node, so
      // the next run finds no block here and stacks another copy.
      if (source.text.slice(source.getPositionOfLineAndCharacter(line, 0), start).trim()) return

      edits.push({from: line, to: null, text: blockFor(fns[0], indent)})
      created += 1

      return
    }

    const from = lineOf(last.pos)
    const to = lineOf(last.end - 1)
    const blockLines = lines.slice(from, to + 1)

    // Ours: safe to rewrite wholesale as the signature evolves.
    if (create && isGeneratedBlock(blockLines)) {
      const fresh = blockFor(fns[0], indent)

      if (fresh.join("\n") !== blockLines.join("\n")) {
        edits.push({from, to, text: fresh})
        completed += 1
      }

      return
    }

    // Hand-written: keep the prose, add only the tags valid-jsdoc asks for.
    const block = blockLines.join("\n")
    const documented = new Set(
      [...block.matchAll(/@param\s+\{[^}]*\}\s+([\w$]+)/g)].map((match) => match[1]),
    )
    const wanted = new Set(fns.flatMap((fn) => documentedParams(fn)))
    const missing = [...wanted].filter((param) => !documented.has(param))
    const wantsReturn = fns.some(needsReturn) && !/@returns?\b/.test(block)

    if (!missing.length && !wantsReturn) return

    const tags = [
      ...missing.map((param) => `${indent} * @param {*} ${param}`),
      ...(wantsReturn ? [`${indent} * @return {*}`] : []),
    ]

    // A one-line `/** ... */` block has no bare `*/` line to insert before:
    // replacing its "closing" line would emit the tags outside the comment, as
    // bare code. Expand it into a block instead.
    if (blockLines.length === 1) {
      const raw = blockLines[0]
      const open = raw.indexOf("/**")
      const close = raw.lastIndexOf("*/")
      const head = raw.slice(0, open)
      const summary = raw.slice(open + 3, close).trim()

      edits.push({
        from,
        to,
        text: [
          `${head}/**${summary ? ` ${summary}` : ""}`,
          ...tags,
          `${head} */`,
        ],
      })
      completed += 1

      return
    }

    edits.push({
      from: to,
      to,
      text: [...tags, blockLines[blockLines.length - 1]],
    })
    completed += 1
  }

  const visit = (node) => {
    if (needsDoc(node)) {
      planEdit(node, [node], true)
    } else {
      const fns = functionIn(node)

      if (fns.length) {
        // A class member arrow with parameters (`private listOrganizations =
        // async (req, res) => ...` -- the route handlers) has no block, so
        // valid-jsdoc walks up and matches the CLASS's block against it, then
        // reports "Missing JSDoc for parameter 'req'" at the class's doc. Give
        // it its own block so the walk stops here.
        //
        // Only member arrows with parameters: documenting every `const f = () =>
        // helper` would add blocks nothing asks for.
        const memberArrow =
          ts.isPropertyDeclaration(node) &&
          fns.some((fn) => documentedParams(fn).length > 0)

        planEdit(node, fns, memberArrow)
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(source)

  if (!edits.length && !lines.some((l) => DISABLE_LINES.includes(l.trim()))) {
    return null
  }

  // Apply bottom-up so earlier line numbers stay valid, THEN strip the opt-outs.
  // Removing the header disables first would shift every edit point up by however
  // many of them sat above the function, and drop blocks mid-code.
  const output = [...lines]
  for (const {from, to, text} of edits.sort((a, b) => b.from - a.from)) {
    if (to === null) output.splice(from, 0, ...text)
    else output.splice(from, to - from + 1, ...text)
  }

  const final = output.filter((line) => !DISABLE_LINES.includes(line.trim()))
  const removed = output.length - final.length

  if (!DRY) writeFileSync(file, final.join("\n"))

  return {created, completed, removed}
}

let files = 0
let created = 0
let completed = 0
let removed = 0

for (const root of roots) {
  for (const file of walk(root)) {
    const result = processFile(file)
    if (!result) continue

    files += 1
    created += result.created
    completed += result.completed
    removed += result.removed
    console.log(
      `${relative(".", file)}: +${result.created} new, ` +
        `~${result.completed} completed, -${result.removed} disables`,
    )
  }
}

console.log(
  `\n${DRY ? "[dry run] " : ""}${files} files: ${created} new blocks, ` +
    `${completed} blocks completed, ${removed} disable lines removed`,
)
