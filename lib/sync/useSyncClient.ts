/**
 * SoufTools Client-Side Cloud Synchronization Hook & State Reconciler
 * 
 * Manages server-authoritative live synchronization:
 * - Ephemeral memory state in UI (no permanent IndexedDB/LocalStorage for user data)
 * - Automatic bootstrap from `/api/v1/sync/bootstrap`
 * - Live SSE subscription to `/api/v1/sync/events`
 * - Optimistic update dispatching with server rollback
 * - Multi-device conflict resolution
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { useChatStore, ChatSession, ChatMessage } from "@/store/chatStore";
import { getOrCreateAuthSession } from "@/lib/authCookies";
import { cloudSyncService } from "@/lib/sync/cloudSyncService";

export interface SyncStatusState {
  status: "connected" | "syncing" | "disconnected" | "error" | "revoked";
  lastSyncedAt: Date | null;
  activeDevicesCount: number;
  unreadNotifications: number;
  errorMessage: string | null;
}

// Generate or retrieve persistent Device ID for this browser
export function getClientDeviceId(): string {
  if (typeof window === "undefined") return "server_render";
  let devId = localStorage.getItem("souftools_device_id");
  if (!devId) {
    devId = `dev_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    try {
      localStorage.setItem("souftools_device_id", devId);
    } catch {}
  }
  return devId;
}

export function useSyncClient() {
  const [syncState, setSyncState] = useState<SyncStatusState>({
    status: "syncing",
    lastSyncedAt: null,
    activeDevicesCount: 1,
    unreadNotifications: 0,
    errorMessage: null,
  });

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef<number>(0);
  const lastCursorRef = useRef<string | null>(null);

  /**
   * 1. Bootstrap: Fetch full initial state from Server
   */
  const executeBootstrap = useCallback(async () => {
    try {
      setSyncState((prev) => ({ ...prev, status: "syncing", errorMessage: null }));
      const deviceId = getClientDeviceId();
      const authSession = getOrCreateAuthSession();

      const res = await fetch("/api/v1/sync/bootstrap", {
        headers: {
          "x-device-id": deviceId,
          "x-user-id": authSession?.userId || "",
          "x-user-email": authSession?.email || "",
        },
      });

      if (!res.ok) {
        if (res.status === 401) {
          setSyncState((prev) => ({ ...prev, status: "disconnected" }));
          return;
        }
        throw new Error(`Bootstrap failed (${res.status})`);
      }

      const data = await res.json().catch(() => null);
      if (!data || !data.success) throw new Error(data?.message || "Bootstrap error");

      lastCursorRef.current = data.serverCursor;

      // Hydrate Zustand Store with Server Source of Truth
      const store = useChatStore.getState();

      if (Array.isArray(data.conversations)) {
        const loadedSessions: ChatSession[] = data.conversations.map((c: any) => ({
          id: c.id,
          title: c.title,
          modelId: (c.modelId as any) || "spark",
          createdAt: new Date(c.createdAt).getTime(),
          updatedAt: new Date(c.updatedAt).getTime(),
          messages: [],
        }));

        // If active conversation has initial messages
        if (data.activeConversationMessages && loadedSessions.length > 0) {
          const firstConv = loadedSessions[0];
          firstConv.messages = data.activeConversationMessages.map((m: any) => ({
            id: m.id,
            role: m.sender === "user" ? "user" : "model",
            content: m.content,
            timestamp: new Date(m.createdAt).getTime(),
            reasoningSteps: m.reasoning ? [m.reasoning] : undefined,
            sources: m.sources || [],
          }));

          useChatStore.setState({
            sessions: loadedSessions,
            activeSessionId: firstConv.id,
            messages: firstConv.messages,
          });
        } else {
          useChatStore.setState({
            sessions: loadedSessions,
            activeSessionId: loadedSessions[0]?.id || null,
            messages: [],
          });
        }
      }

      // Apply server user preferences
      if (data.userPreferences) {
        const p = data.userPreferences;
        if (p.defaultModelId) store.setCurrentModel(p.defaultModelId as any);
        if (p.webSearchEnabled !== undefined) store.setWebSearchEnabled(p.webSearchEnabled);
      }

      setSyncState({
        status: "connected",
        lastSyncedAt: new Date(),
        activeDevicesCount: data.activeDevices?.length || 1,
        unreadNotifications: data.unreadNotificationsCount || 0,
        errorMessage: null,
      });

      reconnectAttemptsRef.current = 0;
    } catch (err: any) {
      console.warn("[CloudSync] Bootstrap warning:", err);
      setSyncState((prev) => ({
        ...prev,
        status: "error",
        errorMessage: err?.message || "تعذر الاتصال بالخادم",
      }));
    }
  }, []);

  /**
   * 2. Real-Time SSE Event Stream
   */
  const connectEventStream = useCallback(() => {
    if (typeof window === "undefined") return;
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    const deviceId = getClientDeviceId();
    const es = new EventSource(`/api/v1/sync/events`);
    eventSourceRef.current = es;

    es.addEventListener("connected", () => {
      setSyncState((prev) => ({
        ...prev,
        status: "connected",
        lastSyncedAt: new Date(),
        errorMessage: null,
      }));
      reconnectAttemptsRef.current = 0;
    });

    es.addEventListener("sync", (e: MessageEvent) => {
      try {
        const event = JSON.parse(e.data);
        const currentDeviceId = getClientDeviceId();

        // Handle security/revocation & pairing events
        if (event.entityType === "device") {
          if (event.payload?.action === "device_linked") {
            cloudSyncService.restoreFromCloud();
            executeBootstrap();
          } else if (
            (event.operation === "deleted" && event.entityId === currentDeviceId) ||
            (event.payload?.action === "revoke_all_other" && event.payload?.exceptDeviceId !== currentDeviceId)
          ) {
            setSyncState((prev) => ({ ...prev, status: "revoked" }));
            es.close();
            return;
          }
        }

        // Handle live message created on another device
        if (event.entityType === "message" && event.operation === "created") {
          const store = useChatStore.getState();
          const p = event.payload;

          if (p.conversationId === store.activeSessionId) {
            // Check if message is already present locally
            const exists = store.messages.some((m) => m.id === p.id);
            if (!exists) {
              const incomingMsg: ChatMessage = {
                id: p.id,
                role: p.sender === "user" ? "user" : "model",
                content: p.content,
                timestamp: new Date(p.createdAt || Date.now()).getTime(),
                reasoningSteps: p.reasoning ? [p.reasoning] : undefined,
                sources: p.sources || [],
              };
              useChatStore.setState((state) => ({
                messages: [...state.messages, incomingMsg],
              }));
            }
          }
        }

        // Handle conversation changes
        if (event.entityType === "conversation") {
          const p = event.payload;
          if (event.operation === "created") {
            useChatStore.setState((state) => {
              const exists = state.sessions.some((s) => s.id === p.id);
              if (exists) return state;
              const newSession: ChatSession = {
                id: p.id,
                title: p.title,
                modelId: p.modelId || "spark",
                createdAt: new Date(p.createdAt || Date.now()).getTime(),
                updatedAt: new Date(p.updatedAt || Date.now()).getTime(),
                messages: [],
              };
              return {
                sessions: [newSession, ...state.sessions],
              };
            });
          } else if (event.operation === "updated") {
            useChatStore.setState((state) => ({
              sessions: state.sessions.map((s) =>
                s.id === p.id ? { ...s, title: p.title || s.title, modelId: p.modelId || s.modelId } : s
              ),
            }));
          } else if (event.operation === "deleted") {
            useChatStore.setState((state) => {
              const filtered = state.sessions.filter((s) => s.id !== p.id);
              return {
                sessions: filtered,
                activeSessionId: state.activeSessionId === p.id ? filtered[0]?.id || null : state.activeSessionId,
                messages: state.activeSessionId === p.id ? filtered[0]?.messages || [] : state.messages,
              };
            });
          }
        }

        setSyncState((prev) => ({
          ...prev,
          lastSyncedAt: new Date(),
        }));
      } catch (err) {
        console.warn("[SSE Parser Error]:", err);
      }
    });

    es.onerror = () => {
      es.close();
      eventSourceRef.current = null;
      setSyncState((prev) => ({ ...prev, status: "disconnected" }));

      // Exponential backoff reconnect
      const attempts = reconnectAttemptsRef.current;
      const delay = Math.min(1000 * Math.pow(2, attempts), 30000);
      reconnectAttemptsRef.current += 1;

      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = setTimeout(() => {
        executeBootstrap().then(connectEventStream);
      }, delay);
    };
  }, [executeBootstrap]);

  // Initial startup
  useEffect(() => {
    executeBootstrap().then(() => {
      connectEventStream();
    });

    const handleOnline = () => {
      executeBootstrap().then(connectEventStream);
    };

    window.addEventListener("online", handleOnline);

    return () => {
      window.removeEventListener("online", handleOnline);
      if (eventSourceRef.current) eventSourceRef.current.close();
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    };
  }, [executeBootstrap, connectEventStream]);

  return {
    syncState,
    refreshSync: executeBootstrap,
    deviceId: getClientDeviceId(),
  };
}
