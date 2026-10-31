import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { api } from './api.js'
import { AiStatus, useThreads } from './useThreads.js'
import ThreadCard, { DraftCard, pausedText } from './ThreadCard.jsx'
import DocChat from './DocChat.jsx'
import AgentPicker from './AgentPicker.jsx'
import { useStored, useStoredSet } from './storage.js'
import { anchorScreenTop, pageTransform, rotateCanvas, screenRectToPage, screenToPage } from './geometry.js'
import { clearHighlights, findMatches, highlightsSupported, pageTexts, rangesIn, setHighlights } from './search.js'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

const PAD = 24 // space above the first page
const GAP = 16 // space between pages
const CARD_GAP = 8
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]

export default function Viewer({ file, onThreadsChanged }) {
  const fileId = file.file_id
  const [pdf, setPdf] = useState(null)
  const [dims, setDims] = useState([]) // unrotated page sizes at scale 1
  const [loadError, setLoadError] = useState(null)
  const [scale, setScale] = useState(1.25)
  const [rotation, setRotation] = useStored(`pdfa:rotation:${fileId}`, 0)
  const [snapMode, setSnapMode] = useState(false)
  const [activeId, setActiveId] = useState(null)
  const [draft, setDraft] = useState(null) // new thread being written
  const [showResolved, setShowResolved] = useState(false)
  const [minimized, setMinimized] = useStoredSet(`pdfa:minimized:${fileId}`) // thread ids shown collapsed
  const [railHidden, setRailHidden] = useStored('pdfa:railHidden', false) // whole comment panel collapsed
  const [docOpen, setDocOpen] = useStored('pdfa:docChatOpen', false) // whole-document Q&A sidebar
  const [noText, setNoText] = useState({}) // page -> true when page has no text layer
  const [textVersion, setTextVersion] = useState(0) // bumps whenever a page's text layer renders
  const [listOpen, setListOpen] = useState(false) // "N comments" dropdown
  const { threads, setThreads, online, status, serverUp } = useThreads(fileId)
  const scrollRef = useRef(null)
  const draftRef = useRef(draft)
  draftRef.current = draft

  // ---- load PDF -----------------------------------------------------------------
  useEffect(() => {
    let cancelled = false
    // pdf.js v6 documents have no destroy(); tearing down the loading task frees the document and its worker.
    const task = pdfjs.getDocument({ url: api.pdfUrl(fileId) })
    task.promise.then(async (d) => {
      const sizes = []
      for (let i = 1; i <= d.numPages; i++) {
        const vp = (await d.getPage(i)).getViewport({ scale: 1 })
        sizes.push({ w: vp.width, h: vp.height })
      }
      if (cancelled) return
      setPdf(d)
      setDims(sizes)
    }).catch((e) => { if (!cancelled) setLoadError(e.message) })
    return () => { cancelled = true; task.destroy().catch(() => {}) }
  }, [fileId])

  useEffect(() => { onThreadsChanged() }, [threads.length, threads.filter((t) => t.resolved).length]) // eslint-disable-line

  // ---- geometry (display sizes account for rotation) ---------------------------------
  const disp = useMemo(() => dims.map((d) => (rotation % 180 ? { w: d.h, h: d.w } : d)), [dims, rotation])
  const pageTops = useMemo(() => {
    let y = PAD
    return disp.map((d) => { const t = y; y += d.h * scale + GAP; return t })
  }, [disp, scale])
  const maxW = Math.max(0, ...disp.map((d) => d.w * scale))
  const totalH = pageTops.length ? pageTops.at(-1) + disp.at(-1).h * scale + PAD : 0

  // ---- page navigation -----------------------------------------------------------------
  const [curPage, setCurPage] = useState(1)
  const [pageInput, setPageInput] = useState(null) // non-null while the user is typing a page number
  const pageInputRef = useRef(null)
  const posRef = useRef({ page: 1, frac: 0 }) // reading position, kept stable across zoom/rotation

  function onScroll() {
    const el = scrollRef.current
    if (!el || !disp.length) return
    const y = el.scrollTop + el.clientHeight / 3
    let i = 0
    pageTops.forEach((t, k) => { if (t <= y) i = k })
    // At the very bottom the last page may never reach the top third; count it as current.
    if (el.scrollTop >= el.scrollHeight - el.clientHeight - 2) i = disp.length - 1
    posRef.current = { page: i + 1, frac: Math.max(0, (y - pageTops[i]) / (disp[i].h * scale)) }
    setCurPage(i + 1)
  }

  // After zooming or rotating, scroll so the same page is where it was.
  useLayoutEffect(() => {
    const el = scrollRef.current
    const { page, frac } = posRef.current
    if (!el || !disp[page - 1]) return
    el.scrollTop = pageTops[page - 1] + frac * disp[page - 1].h * scale - el.clientHeight / 3
  }, [scale, rotation]) // eslint-disable-line

  function goToPage(n) {
    if (!disp.length || Number.isNaN(n)) return
    const page = Math.min(Math.max(1, Math.round(n)), disp.length)
    scrollRef.current?.scrollTo({ top: pageTops[page - 1] - 8 })
    posRef.current = { page, frac: 0 } // the scroll may be clamped (no event), so record it here
    setCurPage(page)
  }

  function fitWidth() {
    const el = scrollRef.current
    if (!el || !disp.length) return
    const railW = railHidden && !draft ? 44 : 320
    const avail = el.clientWidth - railW - 24 * 3 - 40 // side padding, gap, page-number gutter
    const widest = Math.max(...disp.map((d) => d.w))
    setScale(Math.min(4, Math.max(0.25, Math.floor((avail / widest) * 100) / 100)))
  }

  const rotate = () => setRotation((r) => (r + 90) % 360)

  const anchorTop = useCallback((anchor) => {
    const i = anchor.page - 1
    if (!disp[i]) return 0
    return pageTops[i] + anchorScreenTop(anchor, rotation) * disp[i].h * scale
  }, [disp, pageTops, scale, rotation])

  const visibleThreads = useMemo(
    () => threads
      .filter((t) => t.anchor.type !== 'doc' && (showResolved || !t.resolved))
      .sort((a, b) => a.anchor.page - b.anchor.page || anchorScreenTop(a.anchor, rotation) - anchorScreenTop(b.anchor, rotation)),
    [threads, showResolved, rotation],
  )

  // ---- selecting text opens a comment right away ----------------------------------------------
  const openDraft = useCallback((anchor, snapPng) => {
    setDraft({ id: Date.now(), anchor, snapPng, text: '' })
    setRailHidden(false)
    setActiveId('__draft') // also unfocuses whatever comment was focused
  }, [setRailHidden])

  function onPagesMouseUp(e) {
    if (snapMode) return
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.toString().trim()) {
      const hit = hitTest(e)
      if (hit) { setActiveId(hit); setRailHidden(false) }
      return
    }
    if (draftRef.current?.text.trim()) return // never throw away a comment that's being written
    const range = sel.getRangeAt(0)
    const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement
    const pageEl = startEl?.closest('[data-page]')
    if (!pageEl) return
    const page = Number(pageEl.dataset.page)
    const box = pageEl.getBoundingClientRect()
    const rects = mergeRects(
      [...range.getClientRects()]
        .filter((r) => r.width > 1 && r.height > 1 && r.bottom > box.top && r.top < box.bottom &&
          r.right > box.left && r.left < box.right)
        .map((r) => {
          const left = Math.max(r.left, box.left), right = Math.min(r.right, box.right)
          const top = Math.max(r.top, box.top), bottom = Math.min(r.bottom, box.bottom)
          return screenRectToPage({
            x: (left - box.left) / box.width, y: (top - box.top) / box.height,
            w: (right - left) / box.width, h: (bottom - top) / box.height,
          }, rotation)
        }),
    )
    if (!rects.length) return
    openDraft({ type: 'text', page, rects, quote: sel.toString() })
  }

  function hitTest(e) {
    const pageEl = e.target.closest?.('[data-page]')
    if (!pageEl) return null
    const page = Number(pageEl.dataset.page)
    const box = pageEl.getBoundingClientRect()
    const { x, y } = screenToPage((e.clientX - box.left) / box.width, (e.clientY - box.top) / box.height, rotation)
    const hit = visibleThreads.find((t) => t.anchor.page === page &&
      t.anchor.rects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h))
    return hit?.id ?? null
  }

  // ---- snap / ask page ----------------------------------------------------------------------
  // Render a region of a page (unrotated fractions) to a PNG data URL, rotated like the view.
  async function renderRegion(pageNum, rect, minWidth, maxScale) {
    const page = await pdf.getPage(pageNum)
    const base = page.getViewport({ scale: 1 })
    const s = Math.min(maxScale, Math.max(1, minWidth / (rect.w * base.width)))
    const vp = page.getViewport({ scale: s })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(vp.width)
    canvas.height = Math.ceil(vp.height)
    await page.render({ canvas, viewport: vp }).promise
    const crop = document.createElement('canvas')
    crop.width = Math.max(1, Math.round(rect.w * canvas.width))
    crop.height = Math.max(1, Math.round(rect.h * canvas.height))
    crop.getContext('2d').drawImage(canvas, rect.x * canvas.width, rect.y * canvas.height,
      crop.width, crop.height, 0, 0, crop.width, crop.height)
    return rotateCanvas(crop, rotation).toDataURL('image/png')
  }

  async function onSnap(pageNum, rect) {
    setSnapMode(false)
    const png = await renderRegion(pageNum, rect, 1000, 4)
    openDraft({ type: 'snap', page: pageNum, rects: [rect], quote: '' }, png)
  }

  // Ask about the page you're reading; a picture of it goes along so scanned pages work too.
  async function askPage() {
    const page = curPage
    const png = await renderRegion(page, { x: 0, y: 0, w: 1, h: 1 }, 1400, 2.5)
    scrollRef.current?.scrollTo({ top: pageTops[page - 1] - 8, behavior: 'smooth' }) // the card sits at the page top
    setSnapMode(false)
    openDraft({ type: 'page', page, rects: [], quote: '' }, png)
  }

  // ---- search ------------------------------------------------------------------------------------
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState([])
  const [cur, setCur] = useState(-1)
  const [searching, setSearching] = useState(false)
  const searchRef = useRef(null)
  const scrollToMatch = useRef(false)

  useEffect(() => {
    if (!pdf || !searchOpen || !query.trim()) { setMatches([]); setCur(-1); return }
    let stale = false
    setSearching(true)
    const t = setTimeout(async () => {
      const found = findMatches(await pageTexts(pdf), query)
      if (stale) return
      setSearching(false)
      setMatches(found)
      // Start at the first match at or after the page you're reading.
      const start = found.findIndex((m) => m.page >= curPage)
      setCur(found.length ? Math.max(0, start) : -1)
      scrollToMatch.current = true
    }, 150)
    return () => { stale = true; clearTimeout(t) }
  }, [pdf, query, searchOpen]) // eslint-disable-line

  function stepMatch(dir) {
    if (!matches.length) return
    setCur((c) => (c + dir + matches.length) % matches.length)
    scrollToMatch.current = true
  }

  // Jump to the page of the current match; the effect below fine-tunes once its text layer exists.
  useEffect(() => {
    const m = matches[cur]
    if (!m || !scrollToMatch.current) return
    const el = scrollRef.current
    const top = pageTops[m.page - 1]
    if (el && (top > el.scrollTop + el.clientHeight || top + disp[m.page - 1].h * scale < el.scrollTop)) {
      el.scrollTo({ top: top - 8 })
    }
  }, [cur, matches]) // eslint-disable-line

  // Paint highlights on every rendered page, and bring the current match into view.
  useEffect(() => {
    if (!searchOpen || !query.trim() || !matches.length) { clearHighlights(); return }
    const all = []
    let current = null
    const m = matches[cur]
    document.querySelectorAll('.page[data-page]').forEach((pageEl) => {
      const layer = pageEl.querySelector('.textLayer')
      if (!layer) return
      const ranges = rangesIn(layer, query)
      all.push(...ranges)
      if (m && Number(pageEl.dataset.page) === m.page) current = ranges[m.nth] ?? null
    })
    setHighlights(all, current)
    if (current && scrollToMatch.current) {
      scrollToMatch.current = false
      const el = scrollRef.current
      const r = current.getBoundingClientRect()
      const v = el.getBoundingClientRect()
      if (r.top < v.top + 40 || r.bottom > v.bottom - 40) el.scrollBy({ top: r.top - v.top - v.height / 3 })
    }
  }, [matches, cur, textVersion, searchOpen, query, scale, rotation])

  useEffect(() => () => clearHighlights(), [])

  useEffect(() => {
    const up = () => document.querySelectorAll('.textLayer.selecting').forEach((l) => l.classList.remove('selecting'))
    document.addEventListener('pointerup', up)
    window.addEventListener('blur', up)
    return () => { document.removeEventListener('pointerup', up); window.removeEventListener('blur', up) }
  }, [])

  function openSearch() {
    setSearchOpen(true)
    requestAnimationFrame(() => { searchRef.current?.focus(); searchRef.current?.select() })
  }
  function closeSearch() {
    setSearchOpen(false)
    clearHighlights()
  }

  // ---- keyboard ---------------------------------------------------------------------------------
  useEffect(() => {
    function onKey(e) {
      const typing = /^(TEXTAREA|INPUT)$/.test(e.target.tagName)
      const mod = e.ctrlKey || e.metaKey
      if (e.key === 'Escape') {
        setSnapMode(false)
        setListOpen(false)
        if (!typing) { setDraft(null); setActiveId(null) }
      } else if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault() // Ctrl+F: search this PDF
        openSearch()
      } else if (mod && e.key.toLowerCase() === 'g') {
        e.preventDefault() // Ctrl+G: go to page
        pageInputRef.current?.focus()
        pageInputRef.current?.select()
      } else if (!typing && !mod && e.key.toLowerCase() === 's') {
        setSnapMode((m) => !m)
      } else if (!typing && !mod && e.key.toLowerCase() === 'r') {
        rotate()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }) // re-bound each render so handlers see current state

  // ---- thread actions ------------------------------------------------------------------------------
  async function submitDraft(text) {
    const d = draftRef.current
    setDraft({ ...d, text, sending: true, error: null })
    try {
      const t = await api.createThread(fileId, d.anchor, text, d.snapPng)
      setThreads((ts) => ts.some((x) => x.id === t.id) ? ts : [...ts, t])
      setDraft(null)
      setActiveId(t.id)
    } catch (e) {
      setDraft((cur) => cur && { ...cur, text, sending: false, error: e.message })
    }
  }

  // Clicking outside a comment unfocuses it; an untouched (empty) draft is discarded.
  useEffect(() => {
    function onDown(e) {
      if (!e.target.closest?.('.comments-dd, .count-btn')) setListOpen(false)
      if (e.target.closest?.('.card, .pin, .count-btn, .comments-dd')) return
      if (draftRef.current && !draftRef.current.text.trim() && !draftRef.current.sending) {
        setDraft(null)
        setActiveId(null)
        return
      }
      setActiveId((id) => (id === '__draft' ? id : null))
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  function activate(id) {
    setActiveId(id)
    setRailHidden(false)
    const t = threads.find((x) => x.id === id)
    const el = scrollRef.current
    if (!t || !el) return
    const top = anchorTop(t.anchor)
    if (top < el.scrollTop + 40 || top > el.scrollTop + el.clientHeight - 80) {
      el.scrollTo({ top: top - el.clientHeight / 3, behavior: 'smooth' })
    }
  }

  // ---- rail layout (Google Docs style: active card at its anchor, others pushed around it) ----------
  const railRef = useRef(null)
  const layout = useCallback(() => {
    const rail = railRef.current
    if (!rail) return
    const items = [...rail.querySelectorAll(':scope > .card')].map((el) => ({
      el, want: Number(el.dataset.top), h: el.offsetHeight, active: el.dataset.id === activeId,
    })).sort((a, b) => a.want - b.want)
    if (!items.length) return
    let ai = items.findIndex((i) => i.active)
    if (ai < 0) ai = 0
    const tops = new Array(items.length)
    tops[ai] = items[ai].want
    for (let i = ai + 1; i < items.length; i++) tops[i] = Math.max(items[i].want, tops[i - 1] + items[i - 1].h + CARD_GAP)
    for (let i = ai - 1; i >= 0; i--) tops[i] = Math.min(items[i].want, tops[i + 1] - items[i].h - CARD_GAP)
    // The active card stays beside its highlight; cards above it may scroll out of view (as in Google Docs).
    items.forEach((it, i) => { it.el.style.top = `${tops[i]}px` })
  }, [activeId])

  useLayoutEffect(layout)
  useEffect(() => {
    const rail = railRef.current
    if (!rail) return
    const ro = new ResizeObserver(layout)
    const mo = new MutationObserver(() => rail.querySelectorAll(':scope > .card').forEach((c) => ro.observe(c)))
    rail.querySelectorAll(':scope > .card').forEach((c) => ro.observe(c))
    mo.observe(rail, { childList: true })
    return () => { ro.disconnect(); mo.disconnect() }
  }, [layout, pdf])

  // ---- render ------------------------------------------------------------------------------------------
  const highlights = (pageNum) => {
    const hs = visibleThreads.filter((t) => t.anchor.page === pageNum).map((t) => ({
      id: t.id, anchor: t.anchor, active: t.id === activeId, resolved: t.resolved,
    }))
    if (draft && draft.anchor.page === pageNum) hs.push({ id: '__draft', anchor: draft.anchor, active: true })
    return hs
  }
  const allMinimized = visibleThreads.length > 0 && visibleThreads.every((t) => minimized.has(t.id))
  const toggleMinimized = (id) => {
    // Minimizing the focused comment also unfocuses it; otherwise it would stay expanded.
    if (!minimized.has(id) && activeId === id) setActiveId(null)
    setMinimized((m) => {
      const next = new Set(m)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }
  const setAllMinimized = (on) => {
    setMinimized(on ? new Set(threads.map((t) => t.id)) : new Set())
    if (on) setActiveId(null)
  }

  return (
    <AiStatus.Provider value={status}>
    <div className="viewer">
      <div className="toolbar">
        <div className="doc-title" title={file.name}>{file.name}</div>
        <div className="tb-group">
          <button className="icon-btn" title="Zoom out" onClick={() => setScale((s) => ZOOMS.findLast((z) => z < s) ?? s)}>−</button>
          <span className="zoom">{Math.round(scale * 100)}%</span>
          <button className="icon-btn" title="Zoom in" onClick={() => setScale((s) => ZOOMS.find((z) => z > s) ?? s)}>+</button>
          <button className="btn tiny" title="Fit page width" onClick={fitWidth} disabled={!pdf}>Fit</button>
          <button className="icon-btn" title="Rotate pages 90° (R)" onClick={rotate} disabled={!pdf}><RotateIcon /></button>
        </div>
        <div className="tb-group page-nav">
          <button className="icon-btn" title="Previous page" disabled={curPage <= 1} onClick={() => goToPage(curPage - 1)}>‹</button>
          <input ref={pageInputRef} className="page-input" inputMode="numeric" aria-label="Page number"
                 title="Go to page (Ctrl+G)" value={pageInput ?? curPage}
                 onFocus={(e) => { setPageInput(String(curPage)); requestAnimationFrame(() => e.target.select()) }}
                 onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ''))}
                 onKeyDown={(e) => {
                   if (e.key === 'Enter') { goToPage(parseInt(pageInput, 10)); e.currentTarget.blur() }
                   if (e.key === 'Escape') e.currentTarget.blur()
                 }}
                 onBlur={() => setPageInput(null)} />
          <span className="page-total">/ {dims.length || '–'}</span>
          <button className="icon-btn" title="Next page" disabled={curPage >= dims.length} onClick={() => goToPage(curPage + 1)}>›</button>
          <button className={`icon-btn ${searchOpen ? 'on' : ''}`} title="Search this PDF (Ctrl+F)"
                  onClick={() => (searchOpen ? closeSearch() : openSearch())} disabled={!pdf}><SearchIcon /></button>
        </div>
        <div className="tb-group">
          <button className={`btn ${snapMode ? 'primary' : ''}`} title="Snap a region of the page (S)"
                  onClick={() => setSnapMode((m) => !m)}>
            <SnapIcon /> {snapMode ? 'Drag to snap… (Esc)' : 'Snap'}
          </button>
          <button className="btn" onClick={askPage} disabled={!pdf} title="Ask about the page you're looking at">
            <PageIcon /> Ask page
          </button>
        </div>
        <div className="tb-group">
          <button className="btn" disabled={railHidden || !visibleThreads.length} onClick={() => setAllMinimized(!allMinimized)}
                  title={allMinimized ? 'Expand all threads' : 'Collapse every thread to one line'}>
            {allMinimized ? 'Expand all' : 'Minimize all'}
          </button>
          <button className={`btn ${railHidden ? 'primary' : ''}`} onClick={() => setRailHidden((h) => !h)}
                  title={railHidden ? 'Show the comment panel' : 'Hide the comment panel'}>
            {railHidden ? 'Show comments' : 'Hide comments'}
          </button>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
          Show resolved
        </label>
        <div className="count-wrap">
          <button className="count-btn" onClick={() => setListOpen((o) => !o)} disabled={!visibleThreads.length}
                  title="List all comments">
            {visibleThreads.length} comment{visibleThreads.length === 1 ? '' : 's'} ▾
          </button>
          {listOpen && (
            <CommentList threads={visibleThreads} activeId={activeId}
                         onPick={(id) => { setListOpen(false); activate(id) }} />
          )}
        </div>
        <AgentPicker />
        <Status status={status} serverUp={serverUp} />
      </div>

      <div className="viewer-body">
      <div className="scroll-wrap">
      {searchOpen && (
        <div className="search-bar">
          <SearchIcon />
          <input ref={searchRef} value={query} placeholder="Search this PDF" aria-label="Search"
                 onChange={(e) => setQuery(e.target.value)}
                 onKeyDown={(e) => {
                   if (e.key === 'Enter') { e.preventDefault(); stepMatch(e.shiftKey ? -1 : 1) }
                   if (e.key === 'Escape') { e.stopPropagation(); closeSearch() }
                 }} />
          <span className="search-count">
            {!query.trim() ? '' : searching ? '…' : matches.length ? `${cur + 1} of ${matches.length}` : 'No matches'}
          </span>
          <button className="icon-btn" title="Previous match (Shift+Enter)" disabled={!matches.length} onClick={() => stepMatch(-1)}>↑</button>
          <button className="icon-btn" title="Next match (Enter)" disabled={!matches.length} onClick={() => stepMatch(1)}>↓</button>
          <button className="icon-btn" title="Close (Esc)" onClick={closeSearch}>✕</button>
          {!highlightsSupported && <span className="search-note">Highlighting needs a newer browser</span>}
        </div>
      )}
      <div className="scroll" ref={scrollRef} onScroll={onScroll}>
        {loadError && <div className="load-error">Could not open PDF: {loadError}</div>}
        {!pdf && !loadError && <div className="loading"><span className="spinner" /> Loading PDF…</div>}
        {pdf && (
          <div className="doc" style={{ height: totalH }}>
            <div className={`pages ${snapMode ? 'snapping' : ''}`} style={{ width: maxW, height: totalH }} onMouseUp={onPagesMouseUp}>
              {dims.map((d, i) => (
                <Page key={i} pdf={pdf} num={i + 1} top={pageTops[i]} left={(maxW - disp[i].w * scale) / 2}
                      w={d.w * scale} h={d.h * scale} rotation={rotation} scale={scale} highlights={highlights(i + 1)}
                      snapMode={snapMode} onSnap={onSnap} noText={noText[i + 1]}
                      onTextInfo={(empty) => {
                        setNoText((n) => (n[i + 1] === empty ? n : { ...n, [i + 1]: empty }))
                        setTextVersion((v) => v + 1)
                      }} />
              ))}
            </div>
            <div className={`rail ${railHidden && !draft ? 'hidden' : ''}`} ref={railRef}>
              {railHidden && !draft ? visibleThreads.map((t) => (
                <button key={t.id} className={`pin ${t.resolved ? 'resolved' : ''}`} style={{ top: anchorTop(t.anchor) }}
                        title={anchorLabel(t.anchor)} onClick={() => activate(t.id)}>
                  <CommentIcon />{t.messages.filter((m) => m.role === 'user').length}
                </button>
              )) : visibleThreads.map((t) => (
                <ThreadCard key={t.id} thread={t} fileId={fileId} top={anchorTop(t.anchor)}
                            active={t.id === activeId} online={online} onActivate={() => activate(t.id)}
                            onDeleted={() => setActiveId(null)}
                            onResolved={() => setActiveId(null)}
                            minimized={minimized.has(t.id)} onToggleMinimize={() => toggleMinimized(t.id)} />
              ))}
              {draft && (
                <DraftCard key={draft.id} draft={draft} top={anchorTop(draft.anchor)} onSubmit={submitDraft}
                           onTextChange={(text) => setDraft((d) => d && { ...d, text })}
                           onCancel={() => { setDraft(null); setActiveId(null) }} />
              )}
            </div>
          </div>
        )}
      </div>
      </div>
      <DocChat fileId={fileId} threads={threads} online={online} collapsed={!docOpen}
               onToggle={() => setDocOpen((o) => !o)}
               onCreated={(t) => setThreads((ts) => ts.some((x) => x.id === t.id) ? ts : [...ts, t])} />
      </div>
    </div>
    </AiStatus.Provider>
  )
}

function CommentList({ threads, activeId, onPick }) {
  return (
    <div className="comments-dd" role="listbox">
      {threads.map((t) => {
        const q = t.messages.find((m) => m.role === 'user')
        const last = t.messages.at(-1)
        const busy = last?.role === 'ai' && (last.status === 'queued' || last.status === 'answering')
        const failed = last?.role === 'ai' && last.status === 'error'
        return (
          <button key={t.id} className={`dd-item ${t.id === activeId ? 'on' : ''}`} onClick={() => onPick(t.id)}>
            <span className="dd-top">
              <span className="dd-anchor">{anchorLabel(t.anchor)}</span>
              <span className="dd-page">p.{t.anchor.page}</span>
              {busy && <span className="spinner" />}
              {failed && <span className="mini-err">!</span>}
            </span>
            <span className="dd-q">{q?.text}</span>
          </button>
        )
      })}
    </div>
  )
}

function anchorLabel(anchor) {
  if (anchor.type === 'text') return `“${anchor.quote.trim().replace(/\s+/g, ' ')}”`
  if (anchor.type === 'snap') return 'Snap'
  if (anchor.type === 'page') return `Page ${anchor.page}`
  return 'Whole document'
}

function Page({ pdf, num, top, left, w, h, rotation, scale, highlights, snapMode, onSnap, noText, onTextInfo }) {
  const ref = useRef(null)
  const canvasRef = useRef(null)
  const textRef = useRef(null)
  const [visible, setVisible] = useState(false)
  const turned = rotation % 180 !== 0

  useEffect(() => {
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: '800px 0px' })
    io.observe(ref.current)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    let task, textLayer
    let cancelled = false
    pdf.getPage(num).then((page) => {
      if (cancelled) return
      const dpr = window.devicePixelRatio || 1
      const canvas = canvasRef.current
      const vp = page.getViewport({ scale: scale * dpr })
      canvas.width = Math.floor(vp.width)
      canvas.height = Math.floor(vp.height)
      task = page.render({ canvas, viewport: vp })
      task.promise.catch(() => {})

      const container = textRef.current
      container.replaceChildren()
      textLayer = new pdfjs.TextLayer({
        textContentSource: page.streamTextContent(),
        container,
        viewport: page.getViewport({ scale }),
      })
      textLayer.render().then(() => {
        if (cancelled) return
        const end = document.createElement('div')
        end.className = 'endOfContent'
        container.append(end)
        // While dragging, stretch endOfContent under the text so gaps between lines don't make the
        // selection jump to the end of the page (pdf.js viewer's trick; see pdf_viewer.css .selecting).
        container.onmousedown = () => container.classList.add('selecting')
        onTextInfo(!container.textContent.trim())
      }).catch(() => {})
    })
    return () => { cancelled = true; task?.cancel(); textLayer?.cancel() }
  }, [pdf, num, scale, visible]) // eslint-disable-line

  // The outer box takes the rotated size; the inner page is rendered unrotated and turned with CSS,
  // so text selection, highlights and snaps all stay in the page's own coordinates.
  return (
    <div className="page" data-page={num} ref={ref}
         style={{ top, left, width: turned ? h : w, height: turned ? w : h }}>
      <div className="page-inner" style={{ width: w, height: h, transform: pageTransform(rotation, w, h) }}>
        <canvas ref={canvasRef} style={{ width: w, height: h }} />
        <div className="hl-layer">
          {highlights.map((hl) => hl.anchor.rects.map((r, i) => (
            <div key={`${hl.id}-${i}`}
                 className={`hl ${hl.anchor.type} ${hl.active ? 'active' : ''} ${hl.resolved ? 'resolved' : ''}`}
                 style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }} />
          )))}
        </div>
        <div className="textLayer" ref={textRef}
             style={{ '--total-scale-factor': scale, '--scale-round-x': '1px', '--scale-round-y': '1px' }} />
        {snapMode && <SnapLayer rotation={rotation} onSnap={(r) => onSnap(num, r)} />}
      </div>
      {noText && !snapMode && <div className="no-text-hint">No selectable text on this page — use <b>Snap</b> (S)</div>}
      <div className="page-num">{num}</div>
    </div>
  )
}

function SnapLayer({ rotation, onSnap }) {
  const [drag, setDrag] = useState(null)
  const ref = useRef(null)
  // Pointer position in unrotated page fractions (the layer itself is rotated with the page).
  const pt = (e) => {
    const b = ref.current.getBoundingClientRect()
    const p = screenToPage(clamp((e.clientX - b.left) / b.width), clamp((e.clientY - b.top) / b.height), rotation)
    return { x: p.x, y: p.y, cx: e.clientX, cy: e.clientY }
  }
  const rect = drag && {
    x: Math.min(drag.a.x, drag.b.x), y: Math.min(drag.a.y, drag.b.y),
    w: Math.abs(drag.a.x - drag.b.x), h: Math.abs(drag.a.y - drag.b.y),
  }
  return (
    <div className="snap-layer" ref={ref}
         onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); const p = pt(e); setDrag({ a: p, b: p }) }}
         onPointerMove={(e) => drag && setDrag({ ...drag, b: pt(e) })}
         onPointerUp={() => {
           setDrag(null)
           // Ignore clicks / tiny drags (measured on screen, so rotation doesn't matter).
           if (rect && Math.abs(drag.a.cx - drag.b.cx) > 8 && Math.abs(drag.a.cy - drag.b.cy) > 8) onSnap(rect)
         }}>
      {rect && <div className="snap-rect" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }} />}
    </div>
  )
}

function Status({ status, serverUp }) {
  const { online, provider } = status
  const paused = status.paused?.[provider]
  const name = provider === 'openai' ? 'OpenAI' : 'Claude'
  if (!serverUp) return <span className="status down" title="Local server not reachable">● Server offline</span>
  if (online && paused) {
    return (
      <button className="status paused" title={`${pausedText(paused)}\nClick to try again now.`}
              onClick={() => api.resumeProvider(provider).catch(() => {})}>
        ● {name} paused — {paused.kind === 'limit' ? 'usage limit' : paused.kind === 'billing' ? 'subscription' : 'signed out'}
      </button>
    )
  }
  if (!online) return <span className="status offline" title="Questions are saved and will be answered when you are back online">● Offline — questions queued</span>
  return <span className="status online" title="Connected">● Online</span>
}

const clamp = (v) => Math.min(1, Math.max(0, v))

// Merge per-span rects into one rect per line.
function mergeRects(rects) {
  const out = []
  for (const r of rects.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const last = out.at(-1)
    const overlapY = last && Math.min(last.y + last.h, r.y + r.h) - Math.max(last.y, r.y)
    if (last && overlapY > 0.5 * Math.min(last.h, r.h) && r.x <= last.x + last.w + 0.01) {
      const x2 = Math.max(last.x + last.w, r.x + r.w)
      const y2 = Math.max(last.y + last.h, r.y + r.h)
      last.x = Math.min(last.x, r.x)
      last.y = Math.min(last.y, r.y)
      last.w = x2 - last.x
      last.h = y2 - last.y
    } else {
      out.push({ ...r })
    }
  }
  return out
}

export function CommentIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
      <path d="M4 4h16v12H8l-4 4z" />
    </svg>
  )
}

function PageIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round">
      <path d="M6 3h12v18H6z" /><path d="M10 9h4M12 7v4M9 15h6" />
    </svg>
  )
}

export function DocIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round">
      <path d="M6 3h9l4 4v14H6z" /><path d="M9 12h7M9 16h7" />
    </svg>
  )
}

function SnapIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" />
    </svg>
  )
}

function RotateIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" />
    </svg>
  )
}
