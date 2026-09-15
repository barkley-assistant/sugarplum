import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { S } from "./strings";

/** Hand-rolled drag-reorder state machine (D3: no dnd-kit).
 *
 *  - Mouse: lift immediately on pointerdown on the handle.
 *  - Touch: 300ms long-press to lift (haptic via navigator.vibrate), with an
 *    8px movement tolerance so scrolls are never hijacked.
 *  - While dragging: pointermove on window reorders the list locally
 *    (optimistic); pointerup/pointercancel commits the final order.
 *  - Keyboard fallback: ArrowUp/ArrowDown on the focused handle moves the
 *    item; the move is committed on blur or Enter (one PUT per batch).
 *
 *  Listeners are attached once on mount and read mutable refs, so no
 *  add/remove dance is needed while a drag is in flight.
 */

const LONG_PRESS_MS = 300;
const MOVE_TOLERANCE_PX = 8;

export interface HandleProps {
  className: string;
  "aria-label": string;
  onPointerDown: (e: PointerEvent<HTMLButtonElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
  onBlur: () => void;
}

export interface DragReorderHandle {
  /** The order currently displayed (source order, locally reordered while
   *  dragging or after arrow-key moves). */
  orderedIds: string[];
  /** True while a pointer drag is active. */
  isDragging: boolean;
  /** Id of the card currently lifted, if any. */
  draggingId: string | null;
  /** Spread these on each card's drag-handle button. */
  getHandleProps: (id: string) => HandleProps;
}

interface PressState {
  id: string;
  element: HTMLButtonElement;
  pointerId: number;
  x: number;
  y: number;
}

export function useDragReorder(
  items: readonly { id: string }[],
  onCommit: (orderedIds: string[]) => void | Promise<void>,
): DragReorderHandle {
  const [orderOverride, setOrderOverride] = useState<string[] | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const itemsRef = useRef(items);
  const onCommitRef = useRef(onCommit);
  useEffect(() => {
    itemsRef.current = items;
    onCommitRef.current = onCommit;
  });

  const orderRef = useRef<string[] | null>(null);
  const draggingIdRef = useRef<string | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const pressStartRef = useRef<PressState | null>(null);
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCommitRef = useRef<string[] | null>(null);

  const baseIds = items.map((i) => i.id);
  const orderedIds = orderOverride ?? baseIds;

  const clearPress = useCallback(() => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
    pressStartRef.current = null;
  }, []);

  const moveTo = useCallback((ids: string[], id: string, toIndex: number) => {
    const from = ids.indexOf(id);
    if (from === -1) return ids;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(Math.max(0, Math.min(next.length, toIndex)), 0, id);
    return next;
  }, []);

  const commitOrder = useCallback((ids: string[]) => {
    const current = itemsRef.current.map((i) => i.id);
    const changed = ids.length !== current.length || ids.some((id, i) => id !== current[i]);
    if (changed) void onCommitRef.current(ids);
  }, []);

  const commitPending = useCallback(() => {
    if (!pendingCommitRef.current) return;
    const next = pendingCommitRef.current;
    pendingCommitRef.current = null;
    setOrderOverride(null);
    orderRef.current = null;
    commitOrder(next);
  }, [commitOrder]);

  const lift = useCallback((state: PressState) => {
    clearPress();
    try {
      state.element.setPointerCapture(state.pointerId);
    } catch {
      // pointer already released; drag can still proceed via window moves
    }
    pointerIdRef.current = state.pointerId;
    draggingIdRef.current = state.id;
    setDraggingId(state.id);
    setIsDragging(true);
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate?.(10);
    }
  }, [clearPress]);

  const handlePointerDown = useCallback(
    (e: PointerEvent<HTMLButtonElement>, id: string) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (draggingIdRef.current) return;

      const state: PressState = {
        id,
        element: e.currentTarget,
        pointerId: e.pointerId,
        x: e.clientX,
        y: e.clientY,
      };
      pressStartRef.current = state;

      if (e.pointerType === "touch") {
        pressTimerRef.current = setTimeout(() => {
          if (pressStartRef.current === state) lift(state);
        }, LONG_PRESS_MS);
      } else {
        lift(state);
      }
    },
    [lift],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>, id: string) => {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const ids = orderRef.current ?? itemsRef.current.map((i) => i.id);
        const from = ids.indexOf(id);
        if (from === -1) return;
        const to = e.key === "ArrowUp" ? Math.max(0, from - 1) : Math.min(ids.length - 1, from + 1);
        if (to === from) return;
        const next = moveTo(ids, id, to);
        orderRef.current = next;
        setOrderOverride(next);
        pendingCommitRef.current = next;
      } else if (e.key === "Enter") {
        commitPending();
      }
    },
    [commitPending, moveTo],
  );

  const getHandleProps = useCallback(
    (id: string): HandleProps => ({
      className: `drag-handle${draggingId === id ? " is-active" : ""}`,
      "aria-label": S.dnd.moveItem,
      onPointerDown: (e) => handlePointerDown(e, id),
      onKeyDown: (e) => handleKeyDown(e, id),
      onBlur: commitPending,
    }),
    [draggingId, handleKeyDown, handlePointerDown, commitPending],
  );

  // Permanent window listeners: the state machine lives in refs, so the
  // handlers act only when a drag is actually in flight.
  useEffect(() => {
    function onWindowPointerMove(e: globalThis.PointerEvent) {
      const pressed = pressStartRef.current;
      if (pressed && !draggingIdRef.current) {
        const dx = Math.abs(e.clientX - pressed.x);
        const dy = Math.abs(e.clientY - pressed.y);
        if (dx > MOVE_TOLERANCE_PX || dy > MOVE_TOLERANCE_PX) clearPress();
        return;
      }
      const dragged = draggingIdRef.current;
      if (!dragged) return;

      const listEl = (e.target as Element | null)?.closest(".item-list");
      if (!listEl) return;
      const cards = Array.from(listEl.querySelectorAll(".item-card"));
      let skipped = 0;
      let insertBefore = cards.length - 1;
      for (let i = 0; i < cards.length; i++) {
        const card = cards[i] as HTMLElement;
        if (card.dataset.itemId === dragged) {
          skipped++;
          continue;
        }
        const rect = card.getBoundingClientRect();
        if (e.clientY < rect.top + rect.height / 2) {
          insertBefore = i - skipped;
          break;
        }
      }
      const current = orderRef.current ?? itemsRef.current.map((i) => i.id);
      const next = moveTo(current, dragged, insertBefore);
      if (next !== current) {
        orderRef.current = next;
        setOrderOverride(next);
      }
    }

    function finishDrag() {
      const dragged = draggingIdRef.current;
      draggingIdRef.current = null;
      setDraggingId(null);
      setIsDragging(false);
      pointerIdRef.current = null;
      clearPress();

      if (dragged) {
        const finalOrder = orderRef.current ?? itemsRef.current.map((i) => i.id);
        orderRef.current = null;
        setOrderOverride(null);
        commitOrder(finalOrder);
      }
    }

    window.addEventListener("pointermove", onWindowPointerMove);
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", finishDrag);
    return () => {
      window.removeEventListener("pointermove", onWindowPointerMove);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
    };
  }, [clearPress, moveTo, commitOrder]);

  return { orderedIds, isDragging, draggingId, getHandleProps };
}