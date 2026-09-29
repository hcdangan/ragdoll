import type { UIMessage } from "ai";

import type { Citation, FallbackReason } from "./types";

/**
 * Chat message contract shared by the route handler, the transport and the
 * transcript components. Declaring the data parts once means a typo in a part
 * name is a compile error instead of a silently empty citation panel.
 */

export interface CitationData {
  readonly citations: readonly Citation[];
  readonly standaloneQuery?: string;
}

export interface FallbackData {
  readonly answer: string;
  /**
   * Why the answer was replaced. Optional because a draft recovered from an older
   * deployment's stream may not carry it; the default copy is the cautious one.
   */
  readonly reason?: FallbackReason;
}

export interface ChatErrorData {
  readonly code: string;
  readonly message: string;
}

export interface StatusData {
  readonly phase: "retrieval" | "generation" | "groundedness" | "done";
  readonly message: string;
}

export type RagdollMessageData = {
  readonly citation: CitationData;
  readonly fallback: FallbackData;
  readonly error: ChatErrorData;
  readonly status: StatusData;
};

export type RagdollUIMessage = UIMessage<never, RagdollMessageData>;

/** Concatenates the text parts of a message. */
export const messageText = (message: RagdollUIMessage): string =>
  message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");

/** Returns the most recent citation payload in a message, if any. */
export const messageCitations = (message: RagdollUIMessage): readonly Citation[] => {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (part !== undefined && part.type === "data-citation") {
      return (part.data as CitationData).citations;
    }
  }
  return [];
};

/** Returns the latest error payload in a message, if any. */
export const messageError = (message: RagdollUIMessage): ChatErrorData | null => {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (part !== undefined && part.type === "data-error") {
      return part.data as ChatErrorData;
    }
  }
  return null;
};

/** The fallback payload of a message, if the answer was replaced. */
export const messageFallback = (message: RagdollUIMessage): FallbackData | null => {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (part !== undefined && part.type === "data-fallback") {
      return part.data as FallbackData;
    }
  }
  return null;
};

/** Latest transient status phase in a message, if any. */
export const messageStatus = (message: RagdollUIMessage): StatusData | null => {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (part !== undefined && part.type === "data-status") {
      return part.data as StatusData;
    }
  }
  return null;
};
