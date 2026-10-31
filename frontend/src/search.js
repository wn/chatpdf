// In-document search: find matches in every page's text, and highlight them on rendered
// pages with the CSS Custom Highlight API (works on pdf.js's transparent text layer).

const textCache = new WeakMap() // pdf document -> Promise<string[]> (one string per page)

// Page text in the same order pdf.js's TextLayer writes its spans, so offsets line up with the DOM.
export function pageTexts(pdf) {
  if (!textCache.has(pdf)) {
    textCache.set(pdf, (async () => {
      const out = []
      for (let i = 1; i <= pdf.numPages; i++) {
        const tc = await (await pdf.getPage(i)).getTextContent()
        out.push(tc.items.map((it) => it.str ?? '').join(''))
      }
      return out
    })())
  }
  return textCache.get(pdf)
}

export function findMatches(texts, query) {
  const q = query.toLowerCase()
  const matches = []
  if (!q) return matches
  texts.forEach((text, i) => {
    const t = text.toLowerCase()
    let nth = 0
    for (let at = t.indexOf(q); at !== -1; at = t.indexOf(q, at + q.length)) {
      matches.push({ page: i + 1, nth: nth++ })
    }
  })
  return matches
}

// DOM Ranges for every occurrence of query inside one rendered text layer.
export function rangesIn(container, query) {
  const q = query.toLowerCase()
  const nodes = []
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let text = ''
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n, start: text.length })
    text += n.nodeValue
  }
  const lower = text.toLowerCase()
  const locate = (offset) => {
    let lo = 0
    for (let i = 0; i < nodes.length; i++) if (nodes[i].start <= offset) lo = i
    return { node: nodes[lo].node, offset: offset - nodes[lo].start }
  }
  const ranges = []
  for (let at = lower.indexOf(q); q && at !== -1; at = lower.indexOf(q, at + q.length)) {
    const a = locate(at)
    const b = locate(at + q.length - 1)
    const r = document.createRange()
    r.setStart(a.node, a.offset)
    r.setEnd(b.node, b.offset + 1)
    ranges.push(r)
  }
  return ranges
}

export const highlightsSupported = typeof CSS !== 'undefined' && 'highlights' in CSS

export function setHighlights(all, current) {
  if (!highlightsSupported) return
  CSS.highlights.set('pdf-search', new Highlight(...all))
  if (current) CSS.highlights.set('pdf-search-current', new Highlight(current))
  else CSS.highlights.delete('pdf-search-current')
}

export function clearHighlights() {
  if (!highlightsSupported) return
  CSS.highlights.delete('pdf-search')
  CSS.highlights.delete('pdf-search-current')
}
