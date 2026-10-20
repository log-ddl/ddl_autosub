import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ContentCliAdapter } from "@/api/cli-chat-api";
import type { PreviewTarget } from "@/api/preview-api";

export interface ContentMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  steps?: string[];
  /** Motion graphics the agent wrote or changed during this reply. */
  previews?: PreviewTarget[];
  createdAt: number;
}

export interface ContentConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ContentMessage[];
  workspacePath: string | null;
  adapter: ContentCliAdapter | null;
  boundIntegration?: string | null;
  boundProjectId?: string | null;
  boundProjectName?: string | null;
  systemPrompt: string;
  pinned: boolean;
  customTitle: boolean;
}

interface AiEditChatState {
  conversations: ContentConversation[];
  activeConversationId: string | null;
  adapter: ContentCliAdapter;
  models: Record<ContentCliAdapter, string>;
  efforts: Record<ContentCliAdapter, string>;
  createConversation: () => string;
  selectConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  clearConversationMessages: (id: string) => void;
  addMessage: (conversationId: string, message: ContentMessage) => void;
  setAdapter: (adapter: ContentCliAdapter) => void;
  setModel: (adapter: ContentCliAdapter, model: string) => void;
  setEffort: (adapter: ContentCliAdapter, effort: string) => void;
  setConversationWorkspace: (
    conversationId: string,
    workspacePath: string | null,
  ) => void;
  bindConversationAdapter: (
    conversationId: string,
    adapter: ContentCliAdapter,
  ) => void;
  bindConversationTarget: (
    conversationId: string,
    integration: string,
    projectId: string | null,
    projectName: string | null,
  ) => void;
  setConversationSystemPrompt: (
    conversationId: string,
    systemPrompt: string,
  ) => void;
  renameConversation: (conversationId: string, title: string) => void;
  toggleConversationPinned: (conversationId: string) => void;
}

function newConversation(): ContentConversation {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: "Cuộc trò chuyện mới",
    createdAt: now,
    updatedAt: now,
    messages: [],
    workspacePath: null,
    adapter: null,
    boundIntegration: null,
    boundProjectId: null,
    boundProjectName: null,
    systemPrompt: "",
    pinned: false,
    customTitle: false,
  };
}

function titleFromMessage(content: string) {
  const oneLine = content.replace(/\s+/g, " ").trim();
  return oneLine.length > 48 ? `${oneLine.slice(0, 48).trim()}…` : oneLine;
}

function sortConversations(conversations: ContentConversation[]) {
  return [...conversations].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt,
  );
}

export const useAiEditChatStore = create<AiEditChatState>()(
  persist(
    (set) => ({
      conversations: [],
      activeConversationId: null,
      adapter: "agy",
      models: { agy: "", claude: "" },
      efforts: { agy: "", claude: "" },
      createConversation: () => {
        const conversation = newConversation();
        set((state) => ({
          conversations: sortConversations([
            conversation,
            ...state.conversations,
          ]),
          activeConversationId: conversation.id,
        }));
        return conversation.id;
      },
      selectConversation: (activeConversationId) =>
        set({ activeConversationId }),
      deleteConversation: (id) =>
        set((state) => {
          const conversations = state.conversations.filter(
            (item) => item.id !== id,
          );
          return {
            conversations,
            activeConversationId:
              state.activeConversationId === id
                ? (conversations[0]?.id ?? null)
                : state.activeConversationId,
          };
        }),
      clearConversationMessages: (id) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === id
              ? {
                  ...c,
                  messages: [],
                  boundIntegration: null,
                  boundProjectId: null,
                  boundProjectName: null,
                  updatedAt: Date.now(),
                }
              : c,
          ),
        })),
      addMessage: (conversationId, message) =>
        set((state) => ({
          conversations: sortConversations(
            state.conversations.map((conversation) => {
              if (conversation.id !== conversationId) return conversation;
              const isFirstUserMessage =
                message.role === "user" &&
                !conversation.messages.some((item) => item.role === "user");
              return {
                ...conversation,
                title:
                  isFirstUserMessage && !conversation.customTitle
                    ? titleFromMessage(message.content)
                    : conversation.title,
                updatedAt: Date.now(),
                messages: [...conversation.messages, message],
              };
            }),
          ),
        })),
      setAdapter: (adapter) => set({ adapter }),
      setModel: (adapter, model) =>
        set((state) => ({
          models: { ...state.models, [adapter]: model },
        })),
      setEffort: (adapter, effort) =>
        set((state) => ({
          efforts: { ...state.efforts, [adapter]: effort },
        })),
      setConversationWorkspace: (conversationId, workspacePath) =>
        set((state) => ({
          conversations: sortConversations(
            state.conversations.map((conversation) =>
              conversation.id === conversationId
                ? { ...conversation, workspacePath, updatedAt: Date.now() }
                : conversation,
            ),
          ),
        })),
      bindConversationAdapter: (conversationId, adapter) =>
        set((state) => ({
          conversations: state.conversations.map((conversation) =>
            conversation.id === conversationId && !conversation.adapter
              ? { ...conversation, adapter }
              : conversation,
          ),
        })),
      bindConversationTarget: (
        conversationId,
        integration,
        projectId,
        projectName,
      ) =>
        set((state) => ({
          conversations: state.conversations.map((conversation) =>
            conversation.id === conversationId &&
            !conversation.boundIntegration
              ? {
                  ...conversation,
                  boundIntegration: integration,
                  boundProjectId: projectId,
                  boundProjectName: projectName,
                }
              : conversation,
          ),
        })),
      setConversationSystemPrompt: (conversationId, systemPrompt) =>
        set((state) => ({
          conversations: sortConversations(
            state.conversations.map((conversation) =>
              conversation.id === conversationId
                ? { ...conversation, systemPrompt, updatedAt: Date.now() }
                : conversation,
            ),
          ),
        })),
      renameConversation: (conversationId, title) =>
        set((state) => ({
          conversations: state.conversations.map((conversation) =>
            conversation.id === conversationId
              ? { ...conversation, title: title.trim(), customTitle: true }
              : conversation,
          ),
        })),
      toggleConversationPinned: (conversationId) =>
        set((state) => ({
          conversations: sortConversations(
            state.conversations.map((conversation) =>
              conversation.id === conversationId
                ? { ...conversation, pinned: !conversation.pinned }
                : conversation,
            ),
          ),
        })),
    }),
    {
      name: "autosubs-ai-edit-chat",
      version: 2,
    },
  ),
);
