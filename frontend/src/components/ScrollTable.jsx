/**
 * A wide table you can actually scroll.
 *
 * Three things a long, wide table needs and a bare overflow-x:auto does not
 * give: a horizontal scrollbar at the TOP that moves with the table (so nobody
 * scrolls to row 200 to find the one at the bottom), a capped height so the
 * table's own scrollbar stays on screen, and — on the caller's side — a sticky
 * header and first column, which this container's overflow makes possible.
 *
 * Usage:
 *   <ScrollTable>
 *     <table>
 *       <thead className="sticky top-0 z-10 bg-secondary">…first <th> gets `sticky left-0 z-20 bg-secondary`
 *       <tbody>…first <td> in each row gets `sticky left-0 bg-inherit`; the <tr> carries an opaque bg
 *
 * The top bar mirrors the body's scroll width and hides itself when the table
 * fits. Shift + mouse wheel and trackpad swipes keep working on the body.
 */
import { useEffect, useRef, useState } from "react";

export default function ScrollTable({ children, maxHeight = "70vh", className = "" }) {
  const topRef = useRef(null);
  const bodyRef = useRef(null);
  const spacerRef = useRef(null);
  const [needsBar, setNeedsBar] = useState(false);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const sync = () => {
      const w = body.scrollWidth;
      if (spacerRef.current) spacerRef.current.style.width = `${w}px`;
      setNeedsBar(w > body.clientWidth + 1);
    };
    sync();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(sync);
    ro.observe(body);
    if (body.firstElementChild) ro.observe(body.firstElementChild);
    return () => ro.disconnect();
  }, []);

  // Assigning an equal scrollLeft fires no scroll event, so the two never chase each other.
  const fromTop = () => { if (bodyRef.current && topRef.current) bodyRef.current.scrollLeft = topRef.current.scrollLeft; };
  const fromBody = () => { if (bodyRef.current && topRef.current) topRef.current.scrollLeft = bodyRef.current.scrollLeft; };

  return (
    <div className={className}>
      <div ref={topRef} onScroll={fromTop} aria-hidden="true"
        className={`overflow-x-auto overflow-y-hidden border-b border-border bg-secondary/40 ${needsBar ? "" : "hidden"}`}
        style={{ height: 14 }} title="Scroll the table sideways">
        <div ref={spacerRef} style={{ height: 1 }} />
      </div>
      <div ref={bodyRef} onScroll={fromBody} className="overflow-auto" style={{ maxHeight }}>
        {children}
      </div>
    </div>
  );
}
