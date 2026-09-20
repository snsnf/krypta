"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"

const REORDER_MS = 200
const LIFT_SCALE = 1.02

/**
 * Drag-to-reorder for a vertical list, with FLIP for the cards that move out
 * of the way.
 *
 * Four decisions worth keeping, three of them learned the hard way.
 *
 * **The list reorders during the drag**, not on drop, so the gap follows the
 * pointer and the author sees the result before committing.
 *
 * **Sibling motion is a CSS transition, not a keyframe**, so reversing a drag
 * mid-flight retargets from where a card currently is instead of restarting
 * from its origin. `translateAt` reads the live animated value, so an
 * interrupted card is offset from where it visually is rather than from where
 * it was heading.
 *
 * **The move is tracked on `window`, not on the handle, and pointer capture is
 * not used.** Reordering makes React move the dragged card's DOM node, and
 * moving a node drops any pointer capture its subtree held: after the first
 * swap the handle stopped receiving `pointermove` entirely and the card froze
 * in place until the pointer happened to wander back over it. A window
 * listener is immune to where the node has been moved to.
 *
 * **The dragged card is excluded from FLIP**: it is already following the
 * pointer, and animating it toward its own new slot would fight the gesture.
 * Instead the re-slot is absorbed into the pointer anchor (see the layout
 * effect): when the list re-slots, the card's layout position jumps by a
 * neighbour's height, and shifting `startY` by exactly that jump is what keeps
 * the card pinned to the pointer. Re-anchoring to the raw pointer position
 * instead makes the card jump by roughly its own height on every crossing.
 *
 * The node registered per id is the *outer* wrapper, not the bordered card:
 * the card carries `animate-question-in`, whose `both` fill-mode leaves a
 * `transform: scale(1)` in force forever, and a CSS animation outranks inline
 * styles. Every transform written here would be silently discarded.
 */
export function useQuestionReorderDrag(
  ids: string[],
  onMove: (id: string, toIndex: number) => void
) {
  const cards = useRef(new Map<string, HTMLElement>())
  const previousTops = useRef(new Map<string, number>())
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const drag = useRef<{
    id: string
    startY: number
    pointerY: number
    reduced: boolean
  } | null>(null)
  // The window listeners outlive the render that installed them, so they read
  // the list through a ref rather than closing over a stale array.
  const latest = useRef({ ids, onMove })
  // The exact handler identities currently on `window`, so a later render's
  // copies cannot be handed to `removeEventListener` and leave the real ones
  // attached.
  const installed = useRef<Installed>(null)

  /**
   * Only `cards` is cleared here. React detaches and re-attaches an inline ref
   * callback on every render, so clearing `previousTops` too would wipe the
   * FLIP baseline before it could ever be compared against: nothing animated
   * at all. Genuinely departed ids are pruned in the layout effect instead,
   * where `cards` has finished re-attaching.
   */
  function registerCard(id: string, node: HTMLElement | null) {
    if (node) cards.current.set(id, node)
    else cards.current.delete(id)
  }

  function handlePointerMove(event: PointerEvent) {
    const active = drag.current
    if (!active) return

    const node = cards.current.get(active.id)
    if (!node) return
    active.pointerY = event.clientY
    applyDragTransform(node, event.clientY - active.startY, active.reduced)

    // The slot the pointer is currently over, by settled card midpoints. The
    // live translate is subtracted so a sibling still animating into place is
    // compared at its destination, which is what stops a swap oscillating.
    const { ids: current, onMove: move } = latest.current
    const pointer = event.clientY
    const from = current.indexOf(active.id)
    let target = from
    current.forEach((id, index) => {
      if (id === active.id) return
      const sibling = cards.current.get(id)
      if (!sibling) return
      const rect = sibling.getBoundingClientRect()
      const middle = rect.top - translateAt(sibling) + rect.height / 2
      if (pointer > middle && index > target) target = index
      if (pointer < middle && index < target) target = index
    })

    if (target !== from) move(active.id, target)
  }

  function endDrag() {
    const active = drag.current
    if (!active) return
    const node = cards.current.get(active.id)
    if (node) {
      node.style.transition = active.reduced
        ? "none"
        : `transform ${REORDER_MS}ms var(--ease-out)`
      node.style.transform = ""
    }
    detachDrag(installed)
    drag.current = null
    setDraggingId(null)
  }

  function handlePointerDown(
    id: string,
    event: React.PointerEvent<HTMLButtonElement>
  ) {
    // Ignore secondary buttons; a right-click is not a drag.
    if (event.button !== 0) return
    // A second pointer during an active drag would install a second listener
    // pair and orphan the first on `window` forever, leaving its card stuck
    // mid-air with an inline transform nothing clears. Ignore extra touch
    // points once a drag has begun.
    if (drag.current) return
    // Suppress the text selection a drag across the cards would otherwise
    // paint. That also suppresses the focus the press would have moved, so the
    // handle is focused explicitly and stays keyboard-reorderable.
    event.preventDefault()
    event.currentTarget.focus()

    const reduced = prefersReducedMotion()
    drag.current = {
      id,
      startY: event.clientY,
      pointerY: event.clientY,
      reduced,
    }
    const node = cards.current.get(id)
    if (node) applyDragTransform(node, 0, reduced)
    attachDrag(installed, handlePointerMove, endDrag)
    setDraggingId(id)
  }

  // No dependency array: FLIP has to measure after every commit, and the body
  // stays cheap and free of `setState` so this cannot loop.
  useLayoutEffect(() => {
    latest.current = { ids, onMove }
    const active = drag.current
    cards.current.forEach((node, id) => {
      // `offsetTop` rather than a client rect: it is a pure layout position,
      // unaffected by the transforms this hook is in the middle of applying.
      const next = node.offsetTop
      const previous = previousTops.current.get(id)
      previousTops.current.set(id, next)
      if (previous === undefined || previous === next) return

      const delta = previous - next
      if (active && id === active.id) {
        active.startY -= delta
        applyDragTransform(
          node,
          active.pointerY - active.startY,
          active.reduced
        )
        return
      }
      if (prefersReducedMotion()) return

      node.style.transition = "none"
      node.style.transform = `translateY(${delta + translateAt(node)}px)`
      requestAnimationFrame(() => {
        node.style.transition = `transform ${REORDER_MS}ms var(--ease-out)`
        node.style.transform = ""
      })
    })
    previousTops.current.forEach((_, id) => {
      if (!cards.current.has(id)) previousTops.current.delete(id)
    })
  })

  // Unmounting mid-drag must not strand listeners on `window`.
  useEffect(() => () => detachDrag(installed), [])

  return { registerCard, draggingId, handlePointerDown }
}

type Installed = {
  move: (event: PointerEvent) => void
  end: () => void
} | null

/**
 * Module level so the hook body never references a function declared below it,
 * which `react-hooks/immutability` treats as an error.
 */
function attachDrag(
  installed: React.RefObject<Installed>,
  move: (event: PointerEvent) => void,
  end: () => void
) {
  window.addEventListener("pointermove", move)
  window.addEventListener("pointerup", end)
  window.addEventListener("pointercancel", end)
  // Pointer capture would normally guarantee a terminal event; this hook
  // deliberately uses window listeners instead (see the doc comment above),
  // so there is no such guarantee. A mouse drag is usually saved by the
  // browser's implicit capture during the button press, but not always: the
  // pointer can leave the browser window entirely (e.g. onto another
  // application) without ever firing `pointerup`/`pointercancel`. Without this,
  // the card stays lifted and the listeners stay armed indefinitely.
  window.addEventListener("blur", end)
  installed.current = { move, end }
}

function detachDrag(installed: React.RefObject<Installed>) {
  const previous = installed.current
  if (!previous) return
  window.removeEventListener("pointermove", previous.move)
  window.removeEventListener("pointerup", previous.end)
  window.removeEventListener("pointercancel", previous.end)
  window.removeEventListener("blur", previous.end)
  installed.current = null
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/**
 * The lift scale rides on the same inline `transform` as the drag offset:
 * they are one property, so setting them separately would mean the second
 * silently replaced the first. Under reduced motion the offset stays (the card
 * must still follow the pointer) and only the lift is dropped.
 */
function applyDragTransform(
  node: HTMLElement,
  offset: number,
  reduced: boolean
) {
  node.style.transition = "none"
  node.style.transform = reduced
    ? `translateY(${offset}px)`
    : `translateY(${offset}px) scale(${LIFT_SCALE})`
}

/** The currently rendered translateY, mid-transition included. */
function translateAt(node: HTMLElement): number {
  const transform = getComputedStyle(node).transform
  if (!transform || transform === "none") return 0
  try {
    return new DOMMatrixReadOnly(transform).m42
  } catch {
    return 0
  }
}
