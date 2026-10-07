// A small, safe Markdown renderer for Coworker answers. An answer is
// untrusted text (a language model can write it), so every character is
// HTML-escaped first, and only a fixed set of Markdown forms becomes markup:
// headings, paragraphs, lists, tables, code blocks, rules, `code`, **bold**,
// and *italic*. Links and raw HTML stay plain text.

import { escapeHtml } from "./format.js"

const e = escapeHtml
const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+(.*)$/
const FENCE = /^\s*```/

/** Inline forms, applied to escaped text. Code spans are set aside first so their contents stay literal. */
export function inline(text) {
  const codes = []
  let html = e(text).replace(/`([^`]+)`/g, (whole, code) => {
    codes.push(code)
    return `\u0000${codes.length - 1}\u0000`
  })
  html = html.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "<strong>$1</strong>")
  html = html.replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?!\w)/g, "$1<em>$2</em>")
  html = html.replace(/(^|[^\w])_(?=\S)([^_]+?)(?<=\S)_(?!\w)/g, "$1<em>$2</em>")
  return html.replace(/\u0000(\d+)\u0000/g, (whole, index) => `<code>${codes[Number(index)]}</code>`)
}

const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim())
const isSeparator = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line ?? "")

export function renderMarkdown(source) {
  const lines = String(source ?? "").replace(/\u0000/g, "").replace(/\r\n?/g, "\n").split("\n")
  const out = []
  let paragraph = []
  const flush = () => {
    if (paragraph.length) out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`)
    paragraph = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (FENCE.test(line)) {
      flush()
      const body = []
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) body.push(lines[i])
      out.push(`<pre><code>${e(body.join("\n"))}</code></pre>`)
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      // The page already uses h1 and h2, so an answer starts at h3.
      const level = Math.min(Math.max(heading[1].length + 1, 3), 6)
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      continue
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush()
      out.push("<hr>")
      continue
    }
    if (line.trim().startsWith("|") && isSeparator(lines[i + 1])) {
      flush()
      const head = cells(line)
      const rows = []
      for (i += 2; i < lines.length && lines[i].trim().startsWith("|"); i++) rows.push(cells(lines[i]))
      i--
      out.push(`<div class="md-table"><table class="mini-table"><thead><tr>${head.map((cell) => `<th scope="col">${inline(cell)}</th>`).join("")}</tr></thead>` +
        `<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`)
      continue
    }
    const item = LIST_ITEM.exec(line)
    if (item) {
      flush()
      const ordered = /\d/.test(item[1])
      const items = []
      for (; i < lines.length; i++) {
        const match = LIST_ITEM.exec(lines[i])
        if (!match || /\d/.test(match[1]) !== ordered) break
        items.push(match[2])
      }
      i--
      const tag = ordered ? "ol" : "ul"
      out.push(`<${tag} class="md-list">${items.map((text) => `<li>${inline(text)}</li>`).join("")}</${tag}>`)
      continue
    }
    paragraph.push(line.trim())
  }
  flush()
  return out.join("")
}
