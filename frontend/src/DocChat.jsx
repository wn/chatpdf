import { useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import { AiMsg, Composer, UserMsg } from './ThreadCard.jsx'
import { DocIcon } from './Viewer.jsx'
import { useStored } from './storage.js'

const DOC_ANCHOR = { type: 'doc', page: 1, rects: [], quote: '' }

// Chat-style sidebar for questions about the whole document. The conversation is the
// latest unresolved whole-document thread; "Clear context" resolves it and resets the AI session.
export default function DocChat({ fileId, threads, online, collapsed, onToggle, onCreated }) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const listRef = useRef(null)
  const pinned = useRef(true) // follow new text only while the reader is at the bottom
  const [width, setWidth] = useStored('pdfa:docChatWidth', 380)

  // Drag the left edge to resize.
  function startResize(e) {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const move = (ev) => setWidth(clampWidth(startW + startX - ev.clientX))
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      document.body.classList.remove('resizing')
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    document.body.classList.add('resizing')
  }

  const conv = threads
    .filter((t) => t.anchor.type === 'doc' && !t.resolved)
    .sort((a, b) => a.created_at - b.created_at)
    .at(-1)
  const messages = conv?.messages ?? []
  const lastText = messages.at(-1)?.text

  // Follow streaming answers only if the reader hasn't scrolled up to read something else.
  useEffect(() => {
    const el = listRef.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages.length, lastText])
  const onScroll = (e) => {
    const el = e.currentTarget
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  async function ask() {
    const q = text.trim()
    if (!q) return
    setSending(true)
    setError(null)
    try {
      pinned.current = true // asking a question jumps to the bottom to show it
      if (conv) await api.reply(fileId, conv.id, q)
      else onCreated(await api.createThread(fileId, DOC_ANCHOR, q))
      setText('')
    } catch (e) {
      setError(e.message) // question stays in the box
    } finally {
      setSending(false)
    }
  }

  const act = (fn) => () => fn().catch((e) => setError(e.message))

  if (collapsed) {
    return (
      <aside className="side-strip right">
        <button className="icon-btn" title="Show Ask the document" onClick={onToggle}><Chevron dir="left" /></button>
        <button className="icon-btn" title="Show Ask the document" onClick={onToggle}><DocIcon /></button>
        {conv && <span className="strip-count" title="Messages in the current conversation">{messages.filter((m) => m.role === 'user').length}</span>}
      </aside>
    )
  }

  return (
    <aside className="doc-chat" style={{ width: clampWidth(width) }}>
      <div className="resize-handle" title="Drag to resize" onPointerDown={startResize}
           onDoubleClick={() => setWidth(380)} />
      <div className="chat-head">
        <DocIcon />
        <span className="chat-title">Ask the document</span>
        <button className="btn tiny" disabled={!conv}
                title="Start fresh: clears this conversation and the AI's memory of this PDF (it will re-read the document)"
                onClick={act(() => api.resetContext(fileId))}>Clear context</button>
        <button className="icon-btn" title="Minimize" onClick={onToggle}><Chevron dir="right" /></button>
      </div>
      <div className="chat-list" ref={listRef} onScroll={onScroll}>
        {!messages.length && (
          <div className="chat-empty">
            Ask about the PDF as a whole — summaries, key takeaways, how sections relate, what to read first.
          </div>
        )}
        {messages.map((m) => m.role === 'user'
          ? <UserMsg key={m.id} m={m} />
          : <AiMsg key={m.id} m={m} online={online}
                   onStop={act(() => api.stop(fileId, conv.id, m.id))}
                   onRetry={act(() => api.retry(fileId, conv.id, m.id))} />)}
      </div>
      <div className="chat-compose">
        <Composer value={text} onChange={setText} onSubmit={ask} disabled={sending} autoFocus
                  placeholder={conv ? 'Ask a follow-up…' : 'Ask about the whole document…'} />
        {error && <div className="send-error">Couldn't send: {error}. Your question is kept — press Ask to retry.</div>}
        <div className="composer-actions">
          <button className="btn primary" disabled={!text.trim() || sending} onClick={ask}>{sending ? 'Sending…' : 'Ask'}</button>
        </div>
      </div>
    </aside>
  )
}

export function Chevron({ dir }) {
  const d = { left: 'M15 6l-6 6 6 6', right: 'M9 6l6 6-6 6' }[dir]
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
  )
}

const clampWidth = (w) => Math.round(Math.min(Math.max(w, 280), Math.max(320, window.innerWidth * 0.7)))
