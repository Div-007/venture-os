"use client";

import { createContext, useContext } from "react";

export const ChatSidebarContext = createContext({ visible: false, toggle: () => {} });

export function useChatSidebar() {
  return useContext(ChatSidebarContext);
}
