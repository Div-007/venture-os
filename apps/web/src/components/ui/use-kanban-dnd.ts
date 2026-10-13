"use client";

import { useRef, useState, type DragEvent } from "react";

/** Desktop drag-and-drop for status columns; each board keeps its keyboard/touch move control. */
export function useKanbanDnd<Status extends string>(onMove: (taskId: string, status: Status) => void) {
  const draggedId = useRef("");
  const [draggingId, setDraggingId] = useState("");
  const [overStatus, setOverStatus] = useState<Status | null>(null);

  function reset() {
    draggedId.current = "";
    setDraggingId("");
    setOverStatus(null);
  }

  function cardProps(taskId: string) {
    return {
      draggable: true,
      onDragStart: (event: DragEvent<HTMLElement>) => {
        draggedId.current = taskId;
        setDraggingId(taskId);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", taskId);
      },
      onDragEnd: reset,
    };
  }

  function columnProps(status: Status) {
    return {
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!draggedId.current) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setOverStatus(status);
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setOverStatus((current) => current === status ? null : current);
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        if (!draggedId.current) return;
        event.preventDefault();
        const taskId = draggedId.current;
        reset();
        onMove(taskId, status);
      },
    };
  }

  return { cardProps, columnProps, draggingId, overStatus };
}
