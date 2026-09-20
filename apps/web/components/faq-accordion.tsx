"use client"

import { useEffect, useRef } from "react"

const DURATION_MS = 260
// --ease-out, the curve the CSS path in globals.css uses.
const EASING = "cubic-bezier(0.23, 1, 0.32, 1)"

/**
 * The FAQ's open and close motion for browsers that cannot animate it in CSS.
 *
 * globals.css animates `::details-content` to `block-size: auto`, which needs
 * `interpolate-size`. Safari has neither that nor a way to start the answer's
 * fade from a panel that was `content-visibility: hidden`, so it opened with
 * no motion at all. There, and only there, this animates the `<details>`
 * element's own height with the Web Animations API instead. Everywhere else it
 * does nothing and the CSS path runs untouched.
 *
 * Native `<details name>` closes the previously open item the instant another
 * opens, which would snap it shut, so this path takes exclusivity over from
 * the attribute while it runs. Without JavaScript the attribute still applies.
 */
export function FaqAccordion({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = ref.current
    if (!root) return
    const cssCanAnimate =
      typeof CSS !== "undefined" &&
      CSS.supports("interpolate-size", "allow-keywords")
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches
    if (cssCanAnimate || reducedMotion) return

    const items = [...root.querySelectorAll<HTMLDetailsElement>("details")]
    const names = items.map((item) => item.getAttribute("name"))
    items.forEach((item) => item.removeAttribute("name"))
    const running = new Map<
      HTMLDetailsElement,
      { animation: Animation; closing: boolean }
    >()

    const summaryHeight = (item: HTMLDetailsElement) => {
      const summary = item.querySelector("summary")
      const style = getComputedStyle(item)
      return (
        (summary?.getBoundingClientRect().height ?? 0) +
        parseFloat(style.paddingTop) +
        parseFloat(style.paddingBottom) +
        parseFloat(style.borderTopWidth) +
        parseFloat(style.borderBottomWidth)
      )
    }

    const animateHeight = (
      item: HTMLDetailsElement,
      from: number,
      to: number,
      closing: boolean,
      onFinish?: () => void
    ) => {
      running.get(item)?.animation.cancel()
      item.style.overflow = "hidden"
      const animation = item.animate(
        [{ height: `${from}px` }, { height: `${to}px` }],
        { duration: DURATION_MS, easing: EASING }
      )
      running.set(item, { animation, closing })
      // `open` only flips once a close finishes, so the + icon would turn back
      // late; this flag lets globals.css turn it with the motion instead.
      if (closing) item.dataset.closing = "true"
      else delete item.dataset.closing
      animation.onfinish = () => {
        running.delete(item)
        delete item.dataset.closing
        item.style.overflow = ""
        onFinish?.()
      }
    }

    const open = (item: HTMLDetailsElement) => {
      // Measured before cancelling, so a reversed close starts where it is.
      const from = item.getBoundingClientRect().height
      running.get(item)?.animation.cancel()
      item.open = true
      const to = item.getBoundingClientRect().height
      animateHeight(item, from, to, false)
      item.querySelector(".faq-answer")?.animate(
        [
          { opacity: 0, transform: "translateY(-4px)" },
          { opacity: 1, transform: "translateY(0)" },
        ],
        { duration: 200, delay: 60, easing: EASING, fill: "backwards" }
      )
    }

    const close = (item: HTMLDetailsElement) => {
      animateHeight(
        item,
        item.getBoundingClientRect().height,
        summaryHeight(item),
        true,
        () => {
          item.open = false
        }
      )
    }

    const onClick = (event: MouseEvent) => {
      const summary = (event.target as Element).closest("summary")
      const item = summary?.parentElement
      if (
        !summary ||
        !(item instanceof HTMLDetailsElement) ||
        !root.contains(item)
      ) {
        return
      }
      event.preventDefault()
      // A close in flight still has `open` set, so where the item is heading
      // is what counts, not the attribute.
      const closing = running.get(item)?.closing === true
      if (item.open && !closing) {
        close(item)
        return
      }
      items.filter((other) => other !== item && other.open).forEach(close)
      open(item)
    }

    root.addEventListener("click", onClick)
    return () => {
      root.removeEventListener("click", onClick)
      running.forEach(({ animation }) => animation.cancel())
      items.forEach((item, index) => {
        const name = names[index]
        if (name !== null) item.setAttribute("name", name)
        delete item.dataset.closing
      })
    }
  }, [])

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  )
}
