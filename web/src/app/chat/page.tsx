import type { Metadata } from "next";
import type { ReactElement } from "react";

import { ChatPanel } from "@/components/chat/chat-panel";
import { PageHeader } from "@/components/layout/page-header";
import { t } from "@/lib/i18n";

export const metadata: Metadata = {
  title: t("chat.title"),
  description: t("chat.subtitle"),
};

/** Chat route. The panel gates itself on the presence of a pipeline. */
export default function ChatPage(): ReactElement {
  return (
    <>
      <PageHeader titleKey="chat.title" subtitleKey="chat.subtitle" />
      <ChatPanel />
    </>
  );
}
