import { Suspense } from "react";
import { ChatContainer } from "@/components/ChatContainer";

export default function Home() {
  return (
    <main className="h-screen w-screen overflow-hidden">
      <Suspense fallback={<div className="h-screen w-screen bg-[var(--background)]" />}>
        <ChatContainer />
      </Suspense>
    </main>
  );
}
