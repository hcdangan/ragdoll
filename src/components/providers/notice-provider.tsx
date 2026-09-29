"use client";

import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

import { IconAlert, IconCheck, IconClose, IconInfo } from "@/components/ui/icons";
import { t } from "@/lib/i18n";

/**
 * Global notification surface.
 *
 * Action results used to render inline, in the page flow. A failure raised while
 * the user was scrolled to the bottom of a form was therefore pushed off-screen,
 * which reads as "the app did nothing". Everything here is deliberately unlike a
 * page element:
 *
 *  * the stack is `position: fixed`, so a notice is visible from any scroll
 *    position and from any route;
 *  * every notice carries its own close button;
 *  * nothing is persisted — not to storage, not to the session — so a page load
 *    starts with an empty stack by construction, and a soft navigation clears it
 *    as well, because a notice only ever describes the page that raised it.
 */

export type NoticeTone = "info" | "success" | "warning" | "danger";

export interface NoticeInput {
  readonly tone: NoticeTone;
  readonly message: string;
  readonly title?: string;
  /** Optional inline control, e.g. the chat retry affordance. */
  readonly action?: ReactNode;
}

interface Notice extends NoticeInput {
  readonly id: number;
}

export interface NoticeApi {
  readonly notify: (notice: NoticeInput) => void;
  readonly dismiss: (id: number) => void;
  readonly clear: () => void;
}

const NoticeContext = createContext<NoticeApi | null>(null);

/** Visible at once; the oldest is dropped rather than letting the stack grow. */
const MAX_VISIBLE = 4;

export function NoticeProvider({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement {
  const [notices, setNotices] = useState<readonly Notice[]>([]);
  const nextId = useRef(0);
  const mounted = useRef(false);
  const pathname = usePathname();

  const notify = useCallback((input: NoticeInput) => {
    setNotices((current) => {
      // An identical notice already on screen is not repeated: a retry that fails
      // the same way must not stack four copies of one sentence.
      const duplicate = current.some(
        (notice) => notice.tone === input.tone && notice.message === input.message,
      );
      if (duplicate) {
        return current;
      }
      nextId.current += 1;
      return [...current, { ...input, id: nextId.current }].slice(-MAX_VISIBLE);
    });
  }, []);

  const dismiss = useCallback((id: number) => {
    setNotices((current) => current.filter((notice) => notice.id !== id));
  }, []);

  const clear = useCallback(() => {
    setNotices([]);
  }, []);

  useEffect(() => {
    // The first run is the mount that already started empty; clearing there would
    // only discard a notice raised before hydration.
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    setNotices([]);
  }, [pathname]);

  const api = useMemo<NoticeApi>(() => ({ notify, dismiss, clear }), [notify, dismiss, clear]);

  return (
    <NoticeContext.Provider value={api}>
      {children}
      <NoticeStack notices={notices} onDismiss={dismiss} />
    </NoticeContext.Provider>
  );
}

/**
 * Reads the notification API.
 *
 * Throws rather than returning a no-op: a missing provider is a wiring mistake,
 * and silently swallowing the message is exactly the bug this module exists to
 * fix.
 */
export const useNotices = (): NoticeApi => {
  const api = useContext(NoticeContext);
  if (api === null) {
    throw new Error("useNotices must be used inside <NoticeProvider>.");
  }
  return api;
};

/**
 * Tone styling.
 *
 * Colour never carries the message: on a light field only deep teal is dark
 * enough to read, so an "error red" sentence would be exactly the unreadable text
 * it is meant to flag. Tone is a tinted surface plus an accent edge and icon,
 * except for danger, which is reversed out of a solid fill so a failure is
 * unmistakable even in a screenshot.
 */
interface ToneStyle {
  readonly card: string;
  readonly icon: string;
  readonly close: string;
}

const TONE_STYLE: Readonly<Record<NoticeTone, ToneStyle>> = {
  info: {
    card: "border-line border-l-info bg-surface text-ink",
    icon: "text-ink",
    close: "btn-ghost text-ink",
  },
  success: {
    card: "border-line border-l-success bg-surface text-ink",
    icon: "text-ink",
    close: "btn-ghost text-ink",
  },
  warning: {
    card: "border-warning border-l-warning bg-warning/25 text-ink",
    icon: "text-ink",
    close: "btn-ghost text-ink",
  },
  danger: {
    card: "border-danger border-l-danger bg-danger text-ink-inverted",
    icon: "text-ink-inverted",
    close: "btn text-ink-inverted px-2 py-1",
  },
};

const TONE_ICON: Readonly<Record<NoticeTone, ReactElement>> = {
  info: <IconInfo className="h-4 w-4" />,
  success: <IconCheck className="h-4 w-4" />,
  warning: <IconAlert className="h-4 w-4" />,
  danger: <IconAlert className="h-4 w-4" />,
};

/** Fixed viewport stack; `pointer-events-none` keeps the gutter click-through. */
function NoticeStack({
  notices,
  onDismiss,
}: {
  readonly notices: readonly Notice[];
  readonly onDismiss: (id: number) => void;
}): ReactElement | null {
  if (notices.length === 0) {
    return null;
  }
  return (
    <div
      role="region"
      aria-label={t("notice.region")}
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-stretch gap-2 p-3 sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-[26rem] sm:p-0"
    >
      {notices.map((notice) => (
        <NoticeCard key={notice.id} notice={notice} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function NoticeCard({
  notice,
  onDismiss,
}: {
  readonly notice: Notice;
  readonly onDismiss: (id: number) => void;
}): ReactElement {
  const tone = TONE_STYLE[notice.tone];
  return (
    <div
      // A danger notice is announced immediately; everything else waits its turn,
      // so a success message never interrupts a screen-reader user mid-sentence.
      role={notice.tone === "danger" ? "alert" : "status"}
      className={`pointer-events-auto flex items-start gap-3 rounded-xl border border-l-4 px-4 py-3 text-sm shadow-lg ${tone.card}`}
    >
      <span className={`mt-0.5 shrink-0 ${tone.icon}`}>{TONE_ICON[notice.tone]}</span>
      <div className="min-w-0 flex-1">
        {notice.title === undefined ? null : <p className="font-semibold">{notice.title}</p>}
        <p className="break-words">{notice.message}</p>
        {notice.action === undefined ? null : <div className="mt-2">{notice.action}</div>}
      </div>
      <button
        type="button"
        className={`${tone.close} -mr-2 -mt-1 shrink-0`}
        aria-label={t("notice.dismiss")}
        onClick={() => {
          onDismiss(notice.id);
        }}
      >
        <IconClose className="h-4 w-4" />
      </button>
    </div>
  );
}
