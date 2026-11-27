import {
  DndContext,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from '@dnd-kit/core';
import type { TaskStatus } from '@rumo/contract';
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';

import type { DropTarget } from './columns.js';

export const TOUCH_HOLD_MS = 250;
export const TOUCH_TOLERANCE_PX = 8;
export const MOUSE_DISTANCE_PX = 6;

const CLICK_AFTER_DROP_MS = 100;
// dnd-kit keeps clearing every text selection for 50 ms after a drop; WebKit then drops typing
// into a field focused in that window.
const SELECTION_RELEASED_MS = 100;

export const selectionReleased = (): Promise<void> =>
  new Promise((done) => setTimeout(done, SELECTION_RELEASED_MS));

function swallowNextClick(): void {
  const swallow = (event: MouseEvent): void => {
    if (!(event.target instanceof Element) || event.target.closest('article') === null) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const target = window;
  target.addEventListener('click', swallow, true);
  setTimeout(() => target.removeEventListener('click', swallow, true), CLICK_AFTER_DROP_MS);
}

class PointerTypeSensor extends PointerSensor {
  constructor(props: ConstructorParameters<typeof PointerSensor>[0]) {
    const touch = (props.event as PointerEvent).pointerType === 'touch';
    super({
      ...props,
      options: {
        ...props.options,
        activationConstraint: touch
          ? { delay: TOUCH_HOLD_MS, tolerance: TOUCH_TOLERANCE_PX }
          : { distance: MOUSE_DISTANCE_PX },
      },
    });
  }
}

const collide: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  const typeOf = (hit: (typeof hits)[number]): unknown =>
    hit.data?.droppableContainer.data.current?.type;
  const cards = hits.filter((hit) => typeOf(hit) === 'card' && hit.id !== args.active.id);
  return cards.length > 0 ? cards : hits.filter((hit) => typeOf(hit) === 'column');
};

const pointerY = (event: DragEndEvent): number | null => {
  const origin = event.activatorEvent;
  return 'clientY' in origin && typeof origin.clientY === 'number'
    ? origin.clientY + event.delta.y
    : null;
};

export function BoardDnd(props: {
  readonly onDrop: (activeId: string, target: DropTarget) => void;
  readonly children: ReactNode;
}): ReactNode {
  const dragging = useRef(false);
  const sensors = useSensors(useSensor(PointerTypeSensor));

  useEffect(() => {
    const hold = (event: TouchEvent): void => {
      if (dragging.current && event.cancelable) event.preventDefault();
    };
    window.addEventListener('touchmove', hold, { passive: false });
    return () => window.removeEventListener('touchmove', hold);
  }, []);

  const onDragEnd = (event: DragEndEvent): void => {
    dragging.current = false;
    swallowNextClick();
    const { active, over } = event;
    const data = over?.data.current as
      | { type: 'card'; status: TaskStatus; id: string }
      | { type: 'column'; status: TaskStatus }
      | undefined;
    if (over === null || data === undefined) return;
    if (data.type === 'column') {
      props.onDrop(String(active.id), { status: data.status, overCard: null, before: false });
      return;
    }
    const y = pointerY(event);
    const middle = over.rect.top + over.rect.height / 2;
    props.onDrop(String(active.id), {
      status: data.status,
      overCard: data.id,
      before: y === null ? true : y < middle,
    });
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collide}
      onDragStart={() => {
        dragging.current = true;
      }}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        dragging.current = false;
        swallowNextClick();
      }}
    >
      {props.children}
    </DndContext>
  );
}

export function useCardDrag(
  id: string,
  status: TaskStatus,
  draggable: boolean,
  droppable: boolean,
) {
  const drag = useDraggable({ id, disabled: !draggable });
  const drop = useDroppable({ id, disabled: !droppable, data: { type: 'card', status, id } });
  const style: CSSProperties = {
    transform:
      drag.transform === null
        ? undefined
        : `translate3d(${drag.transform.x}px, ${drag.transform.y}px, 0)`,
    zIndex: drag.isDragging ? 20 : undefined,
    position: drag.isDragging ? 'relative' : undefined,
    opacity: drag.isDragging ? 0.85 : undefined,
    userSelect: draggable ? 'none' : undefined,
    WebkitTouchCallout: draggable ? 'none' : undefined,
  };
  return {
    setNodeRef: (node: HTMLElement | null) => {
      drag.setNodeRef(node);
      drop.setNodeRef(node);
    },
    listeners: draggable ? drag.listeners : undefined,
    style,
    isDragging: drag.isDragging,
    isOver: drop.isOver,
  };
}

export function useColumnDrop(status: TaskStatus, enabled: boolean) {
  const drop = useDroppable({
    id: `column:${status}`,
    disabled: !enabled,
    data: { type: 'column', status },
  });
  return { setNodeRef: drop.setNodeRef, isOver: drop.isOver };
}
