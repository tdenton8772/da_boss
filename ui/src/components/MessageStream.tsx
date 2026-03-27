import { useEffect, useRef } from "react";

export interface Message {
  role: string;
  content: string;
  timestamp: string;
}

export function MessageStream({ messages }: { messages: Message[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  if (messages.length === 0) {
    return (
      <div className="text-gray-600 text-sm text-center py-8">
        No messages yet
      </div>
    );
  }

  return (
    <div className="space-y-2 overflow-y-auto max-h-[60vh] p-2">
      {messages.map((msg, i) => (
        <div key={i} className="text-sm">
          <div className="flex items-center gap-2 mb-0.5">
            <span
              className={`text-xs font-medium ${
                msg.role === "assistant"
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
          <div className="text-gray-300 whitespace-pre-wrap font-mono text-xs leading-relaxed bg-gray-900/50 rounded p-2">
            {msg.content}
          </div>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
