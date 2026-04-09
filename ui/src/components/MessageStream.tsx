import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export interface Message {
  role: string;
  content: string;
  timestamp: string;
}

export function MessageStream({ messages }: { messages: Message[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);

  // Detect if user has scrolled up from bottom
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      setUserScrolledUp(!atBottom);
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Only auto-scroll if user is at the bottom
  useEffect(() => {
    if (!userScrolledUp) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages.length, userScrolledUp]);

  if (messages.length === 0) {
    return (
      <div className="text-gray-600 text-sm text-center py-8">
        No messages yet
      </div>
    );
  }

  return (
    <div ref={containerRef} className="space-y-2 overflow-y-auto max-h-[60vh] p-2">
      {messages.map((msg, i) => (
        <div key={i} className="text-sm">
          <div className="flex items-center gap-2 mb-0.5">
            <span
              className={`text-xs font-medium ${
                msg.role === "user"
                  ? "text-purple-400"
                  : msg.role === "assistant"
                    ? "text-blue-400"
                    : msg.role === "tool"
                      ? "text-green-400"
                      : "text-gray-500"
              }`}
            >
              {msg.role}
            </span>
            <span className="text-xs text-gray-600">
              {new Date(msg.timestamp).toLocaleTimeString()}
            </span>
          </div>
          <div className="text-gray-300 text-xs leading-relaxed bg-gray-900/50 rounded p-2 prose prose-invert prose-xs max-w-none
            prose-headings:text-gray-200 prose-headings:mt-2 prose-headings:mb-1
            prose-p:my-1 prose-p:text-gray-300
            prose-a:text-blue-400
            prose-strong:text-gray-200
            prose-code:text-green-400 prose-code:bg-gray-800 prose-code:px-1 prose-code:rounded prose-code:text-xs
            prose-pre:bg-gray-800 prose-pre:border prose-pre:border-gray-700 prose-pre:rounded prose-pre:text-xs
            prose-li:text-gray-300 prose-li:my-0
            prose-table:text-xs
            prose-th:text-gray-300 prose-th:border prose-th:border-gray-700 prose-th:px-2 prose-th:py-1
            prose-td:text-gray-400 prose-td:border prose-td:border-gray-700 prose-td:px-2 prose-td:py-1
            prose-hr:border-gray-700">
            <Markdown remarkPlugins={[remarkGfm]}>{msg.content}</Markdown>
          </div>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
