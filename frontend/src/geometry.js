// Anchors are stored in *unrotated* page fractions (0..1), so they survive zoom and rotation.
// These helpers convert between that frame and the on-screen (rotated) page box.

// Screen fraction (u, v) inside the rotated page box -> unrotated page fraction (x, y).
export function screenToPage(u, v, rot) {
  switch (rot) {
    case 90: return { x: v, y: 1 - u }
    case 180: return { x: 1 - u, y: 1 - v }
    case 270: return { x: 1 - v, y: u }
    default: return { x: u, y: v }
  }
}

// Unrotated page fraction -> screen fraction.
export function pageToScreen(x, y, rot) {
  switch (rot) {
    case 90: return { u: 1 - y, v: x }
    case 180: return { u: 1 - x, v: 1 - y }
    case 270: return { u: y, v: 1 - x }
    default: return { u: x, v: y }
  }
}

// An axis-aligned screen rect (fractions) -> page rect (fractions).
export function screenRectToPage(r, rot) {
  const a = screenToPage(r.x, r.y, rot)
  const b = screenToPage(r.x + r.w, r.y + r.h, rot)
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
}

// Topmost on-screen point of an anchor as a fraction of the displayed page height.
export function anchorScreenTop(anchor, rot) {
  if (!anchor.rects.length) return 0
  let top = 1
  for (const r of anchor.rects) {
    for (const [x, y] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]) {
      top = Math.min(top, pageToScreen(x, y, rot).v)
    }
  }
  return top
}

// CSS transform that rotates a w×h page (px) inside its rotated slot, origin top-left.
export function pageTransform(rot, w, h) {
  switch (rot) {
    case 90: return `translateX(${h}px) rotate(90deg)`
    case 180: return `translate(${w}px, ${h}px) rotate(180deg)`
    case 270: return `translateY(${w}px) rotate(270deg)`
    default: return 'none'
  }
}

// Rotate a canvas clockwise by rot degrees (so snaps match what the reader sees).
export function rotateCanvas(src, rot) {
  if (!rot) return src
  const c = document.createElement('canvas')
  c.width = rot % 180 ? src.height : src.width
  c.height = rot % 180 ? src.width : src.height
  const ctx = c.getContext('2d')
  ctx.translate(c.width / 2, c.height / 2)
  ctx.rotate((rot * Math.PI) / 180)
  ctx.drawImage(src, -src.width / 2, -src.height / 2)
  return c
}
