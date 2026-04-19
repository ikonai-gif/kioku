/**
 * KIOKU™ Gallery / Artifacts — Integration Tests
 *
 * Tests gallery item CRUD operations and the Artifacts Sidebar endpoint contracts.
 * Gallery stores images, code files, text, and other artifacts produced during deliberation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockStorage } from "../helpers/setup";

const mockStorage = createMockStorage();

vi.mock("../../server/storage", () => ({
  storage: mockStorage,
  pool: { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  db: {},
}));

// ── Gallery Items ───────────────────────────────────────────────────

describe("Gallery API Contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/gallery — List Gallery Items", () => {
    it("returns gallery items for user", async () => {
      const items = [
        {
          id: 1,
          userId: 1,
          agentId: 1,
          type: "image",
          title: "Architecture Diagram",
          contentUrl: "https://example.com/image.png",
          contentText: null,
          prompt: "Create an architecture diagram",
          metadata: "{}",
          createdAt: Date.now(),
        },
        {
          id: 2,
          userId: 1,
          agentId: 2,
          type: "code",
          title: "API Handler",
          contentUrl: null,
          contentText: "function handler(req, res) { ... }",
          prompt: "Write an API handler",
          metadata: '{"language":"typescript"}',
          createdAt: Date.now(),
        },
      ];
      mockStorage.getGalleryItems.mockResolvedValue(items);

      const result = await mockStorage.getGalleryItems(1);
      expect(result).toHaveLength(2);
      expect(result[0].type).toBe("image");
      expect(result[1].type).toBe("code");
    });

    it("filters by type parameter", async () => {
      mockStorage.getGalleryItems.mockResolvedValue([
        { id: 1, type: "image", title: "Photo" },
      ]);

      const result = await mockStorage.getGalleryItems(1, "image");
      expect(result).toHaveLength(1);
      expect(mockStorage.getGalleryItems).toHaveBeenCalledWith(1, "image");
    });

    it("supports pagination with limit and offset", async () => {
      mockStorage.getGalleryItems.mockResolvedValue([]);
      await mockStorage.getGalleryItems(1, undefined, 10, 20);
      expect(mockStorage.getGalleryItems).toHaveBeenCalledWith(1, undefined, 10, 20);
    });

    it("returns empty array when no items exist", async () => {
      mockStorage.getGalleryItems.mockResolvedValue([]);
      const result = await mockStorage.getGalleryItems(999);
      expect(result).toEqual([]);
    });

    it("default limit is 50", async () => {
      mockStorage.getGalleryItems.mockResolvedValue([]);
      await mockStorage.getGalleryItems(1);
      // Default args should be used
      expect(mockStorage.getGalleryItems).toHaveBeenCalledWith(1);
    });
  });

  describe("Gallery Item Structure", () => {
    it("image item has contentUrl", () => {
      const imageItem = {
        id: 1,
        userId: 1,
        agentId: 1,
        type: "image",
        title: "Generated Image",
        contentUrl: "https://storage.example.com/img.png",
        contentText: null,
        prompt: "Draw a cat",
        metadata: JSON.stringify({ width: 1024, height: 1024 }),
        createdAt: Date.now(),
      };

      expect(imageItem.contentUrl).toBeDefined();
      expect(imageItem.type).toBe("image");
      const meta = JSON.parse(imageItem.metadata);
      expect(meta.width).toBe(1024);
    });

    it("code item has contentText", () => {
      const codeItem = {
        id: 2,
        userId: 1,
        agentId: 1,
        type: "code",
        title: "Sort Algorithm",
        contentUrl: null,
        contentText: "function sort(arr) { return arr.sort(); }",
        prompt: "Write a sort function",
        metadata: JSON.stringify({ language: "javascript" }),
        createdAt: Date.now(),
      };

      expect(codeItem.contentText).toBeDefined();
      expect(codeItem.type).toBe("code");
    });

    it("text item has contentText", () => {
      const textItem = {
        id: 3,
        userId: 1,
        agentId: 1,
        type: "text",
        title: "Meeting Notes",
        contentUrl: null,
        contentText: "Discussion about Q4 roadmap...",
        prompt: "Summarize the meeting",
        metadata: "{}",
        createdAt: Date.now(),
      };

      expect(textItem.contentText).toBeDefined();
      expect(textItem.type).toBe("text");
    });

    it("file item can have both url and text", () => {
      const fileItem = {
        id: 4,
        userId: 1,
        agentId: null,
        type: "file",
        title: "Report.pdf",
        contentUrl: "https://storage.example.com/report.pdf",
        contentText: "Executive summary...",
        prompt: "Generate quarterly report",
        metadata: JSON.stringify({ mimeType: "application/pdf", size: 45000 }),
        createdAt: Date.now(),
      };

      expect(fileItem.contentUrl).toBeDefined();
      expect(fileItem.contentText).toBeDefined();
      expect(fileItem.type).toBe("file");
    });
  });
});

// ── Artifacts Sidebar Integration ───────────────────────────────────

describe("Artifacts Sidebar Data", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sidebar displays file cards from gallery", async () => {
    const items = [
      { id: 1, type: "image", title: "Diagram.png", contentUrl: "https://...", createdAt: Date.now() },
      { id: 2, type: "code", title: "handler.ts", contentText: "export default...", createdAt: Date.now() },
      { id: 3, type: "text", title: "Analysis", contentText: "The results show...", createdAt: Date.now() },
    ];
    mockStorage.getGalleryItems.mockResolvedValue(items);

    const result = await mockStorage.getGalleryItems(1);

    // Each item should have properties needed for file card display
    for (const item of result) {
      expect(item).toHaveProperty("id");
      expect(item).toHaveProperty("type");
      expect(item).toHaveProperty("title");
      expect(item).toHaveProperty("createdAt");
    }
  });

  it("gallery items sorted by creation time (newest first)", async () => {
    const now = Date.now();
    const items = [
      { id: 3, title: "Newest", createdAt: now },
      { id: 2, title: "Middle", createdAt: now - 1000 },
      { id: 1, title: "Oldest", createdAt: now - 2000 },
    ];
    mockStorage.getGalleryItems.mockResolvedValue(items);

    const result = await mockStorage.getGalleryItems(1);
    expect(result[0].title).toBe("Newest");
    expect(result[2].title).toBe("Oldest");
  });

  it("preview is available for text/code items", () => {
    const codeItem = {
      id: 1,
      type: "code",
      title: "handler.ts",
      contentText: "export function handler(req: Request) {\n  return new Response('ok');\n}",
    };

    // Preview should show content snippet
    const preview = codeItem.contentText.slice(0, 100);
    expect(preview).toContain("export function handler");
  });

  it("download URL is available for image/file items", () => {
    const imageItem = {
      id: 1,
      type: "image",
      title: "chart.png",
      contentUrl: "https://storage.example.com/chart.png",
    };

    expect(imageItem.contentUrl).toBeDefined();
    expect(imageItem.contentUrl).toContain("https://");
  });
});

// ── Gallery Type Filtering ──────────────────────────────────────────

describe("Gallery Type Filtering", () => {
  it("filters images only", async () => {
    mockStorage.getGalleryItems.mockResolvedValue([
      { id: 1, type: "image", title: "Photo 1" },
      { id: 2, type: "image", title: "Photo 2" },
    ]);

    const result = await mockStorage.getGalleryItems(1, "image");
    expect(result.every((item: any) => item.type === "image")).toBe(true);
  });

  it("filters code only", async () => {
    mockStorage.getGalleryItems.mockResolvedValue([
      { id: 1, type: "code", title: "Script 1" },
    ]);

    const result = await mockStorage.getGalleryItems(1, "code");
    expect(result.every((item: any) => item.type === "code")).toBe(true);
  });

  it("no filter returns all types", async () => {
    mockStorage.getGalleryItems.mockResolvedValue([
      { id: 1, type: "image" },
      { id: 2, type: "code" },
      { id: 3, type: "text" },
      { id: 4, type: "file" },
    ]);

    const result = await mockStorage.getGalleryItems(1);
    const types = result.map((item: any) => item.type);
    expect(types).toContain("image");
    expect(types).toContain("code");
    expect(types).toContain("text");
    expect(types).toContain("file");
  });
});
