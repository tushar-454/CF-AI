import { Suspense } from "react";
import { ChatContainer } from "@/components/ChatContainer";

export default function Home() {
  return (
    <main className="h-dvh w-screen overflow-hidden">
      <Suspense fallback={<div className="h-dvh w-screen bg-[var(--background)]" />}>
        <ChatContainer />
      </Suspense>
    </main>
  );
}
