import { useState, useRef, useEffect, useCallback } from "react";
import { Send, Loader2 } from "lucide-react";
import { API_BASE } from "@/lib/queryClient";

interface Message {
  id: string;
  role: "luca" | "user";
  content: string;
}

function getOrCreateSessionId(): string {
  const match = document.cookie.match(/(?:^|;\s*)kioku_demo_sid=([^;]*)/);
  if (match) return match[1];
  const sid = crypto.randomUUID();
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toUTCString();
  document.cookie = `kioku_demo_sid=${sid}; path=/; expires=${expires}; SameSite=Lax; Secure`;
  return sid;
}

export default function DemoChat() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "greeting",
      role: "luca",
      content: "Hey! I'm Luca. Want to know what I can do? Ask me anything.",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [limitReached, setLimitReached] = useState(false);
  const [userMsgCount, setUserMsgCount] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sessionId = useRef(getOrCreateSessionId());

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  async function handleSend() {
    const text = input.trim();
    if (!text || loading || limitReached) return;

    const userMsg: Message = { id: crypto.randomUUID(), role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);
    setUserMsgCount((c) => c + 1);

    try {
      const res = await fetch(`${API_BASE}/api/demo/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ message: text, sessionId: sessionId.current }),
      });
      const data = await res.json();

      if (data.limitReached) {
        setLimitReached(true);
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "luca",
            content: "Thanks for trying me out! Want to keep chatting? Sign up for free and get the full experience.",
          },
        ]);
        return;
      }

      if (!res.ok) {
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: "luca", content: data.error || "Something went wrong. Try again!" },
        ]);
        return;
      }

      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "luca", content: data.reply },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "luca", content: "Connection issue. Please try again." },
      ]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  return (
    <div className="demo-chat">
      {/* Header */}
      <div className="demo-chat-header">
        <div className="demo-chat-avatar">
          <span>L</span>
        </div>
        <div>
          <div className="demo-chat-name">Luca</div>
          <div className="demo-chat-status">KIOKU™ AI Companion</div>
        </div>
      </div>

      {/* Messages */}
      <div className="demo-chat-messages" ref={scrollRef}>
        {messages.map((msg) => (
          <div key={msg.id} className={`demo-msg demo-msg-${msg.role}`}>
            {msg.role === "luca" && (
              <div className="demo-msg-avatar">
                <span>L</span>
              </div>
            )}
            <div className={`demo-msg-bubble demo-msg-bubble-${msg.role}`}>
              {msg.content}
            </div>
          </div>
        ))}
        {loading && (
          <div className="demo-msg demo-msg-luca">
            <div className="demo-msg-avatar">
              <span>L</span>
            </div>
            <div className="demo-msg-bubble demo-msg-bubble-luca demo-typing">
              <span className="demo-dot" />
              <span className="demo-dot" />
              <span className="demo-dot" />
            </div>
          </div>
        )}
      </div>

      {/* Input or CTA */}
      {limitReached ? (
        <div className="demo-chat-cta">
          <a href="#/login" className="demo-cta-btn">
            Sign Up Free — Unlock Full Luca
          </a>
        </div>
      ) : (
        <div className="demo-chat-input-row">
          <input
            ref={inputRef}
            type="text"
            className="demo-chat-input"
            placeholder={userMsgCount >= 10 ? "Demo limit reached" : "Ask Luca anything..."}
            value={input}
            maxLength={500}
            disabled={loading || limitReached}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
          />
          <button
            className="demo-send-btn"
            onClick={handleSend}
            disabled={!input.trim() || loading || limitReached}
            aria-label="Send message"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      )}

      {/* Footer badge */}
      <div className="demo-chat-footer">
        Powered by KIOKU™
      </div>
    </div>
  );
}
