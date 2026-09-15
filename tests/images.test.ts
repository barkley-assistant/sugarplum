// tests/images.test.ts — LOCAL http server serves image bytes; no external sites
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { serve } from "bun";
import { createTestApp, type Jar, type TestAppHandle } from "./helpers";
import { downloadImage, serveItemImage } from "../src/server/images";
import type { SearxngFetch } from "../src/server/searxng";
import type { OwnedItem } from "../src/shared/types";

// 1x1 transparent PNG (magic: 89 50 4E 47 0D 0A 1A 0A)
const PNG_1X1 = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);
// Minimal JPEG payload (magic: FF D8 FF)
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);

async function login(jar: Jar, username: string, password: string): Promise<void> {
  const res = await jar.request("POST", "/api/auth/login", { username, password });
  expect(res.status).toBe(200);
}

describe("downloadImage", () => {
  test("png served locally → written to imagesDir/<itemId>.png; content-type trusted", async () => {
    const srv = serve({
      port: 0,
      fetch: () => new Response(PNG_1X1, { headers: { "Content-Type": "image/png" } }),
    });
    const dir = mkdtempSync(join(tmpdir(), "img-test-"));
    try {
      const name = await downloadImage(`${srv.url}pic`, "item-1", { imagesDir: dir, allowPrivate: true });
      expect(name).toBe("item-1.png");
      const file = Bun.file(join(dir, "item-1.png"));
      expect(await file.exists()).toBe(true);
      expect((await file.bytes()).length).toBe(PNG_1X1.length);
    } finally {
      srv.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("octet-stream or missing content-type → magic-byte sniff picks the extension", async () => {
    const srv = serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/octet") {
          return new Response(PNG_1X1, { headers: { "Content-Type": "application/octet-stream" } });
        }
        return new Response(JPEG_BYTES);
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "img-test-"));
    try {
      const png = await downloadImage(`${srv.url}octet`, "item-2", { imagesDir: dir, allowPrivate: true });
      expect(png).toBe("item-2.png");
      const jpg = await downloadImage(`${srv.url}jpeg`, "item-3", { imagesDir: dir, allowPrivate: true });
      expect(jpg).toBe("item-3.jpg");
    } finally {
      srv.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("text/html at an image URL → REJECTED (bot-wall page must never be saved)", async () => {
    const srv = serve({
      port: 0,
      fetch: () => new Response("<html><body>captcha</body></html>", { headers: { "Content-Type": "text/html" } }),
    });
    const dir = mkdtempSync(join(tmpdir(), "img-test-"));
    try {
      const name = await downloadImage(`${srv.url}pic`, "item-4", { imagesDir: dir, allowPrivate: true });
      expect(name).toBeNull();
      expect(await Bun.file(join(dir, "item-4.html")).exists()).toBe(false);
    } finally {
      srv.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(">5MB → rejected via Content-Length/stream cap", async () => {
    const big = new Uint8Array(6 * 1024 * 1024);
    big[0] = 0x89;
    big[1] = 0x50;
    big[2] = 0x4e;
    big[3] = 0x47; // PNG magic — sniff would pass if the cap didn't fire
    const srv = serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/cl") {
          // Known Content-Length → early reject.
          return new Response(big, { headers: { "Content-Type": "image/png" } });
        }
        // Streamed body, no Content-Length → reader cap rejects past 5MB.
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(5 * 1024 * 1024 + 10).fill(0x42));
            controller.close();
          },
        });
        return new Response(stream, { headers: { "Content-Type": "image/png" } });
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "img-test-"));
    try {
      const byLength = await downloadImage(`${srv.url}cl`, "item-5", { imagesDir: dir, allowPrivate: true });
      expect(byLength).toBeNull();
      expect(await Bun.file(join(dir, "item-5.png")).exists()).toBe(false);

      const byStream = await downloadImage(`${srv.url}stream`, "item-6", { imagesDir: dir, allowPrivate: true });
      expect(byStream).toBeNull();
      expect(await Bun.file(join(dir, "item-6.png")).exists()).toBe(false);
    } finally {
      srv.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("404 / connection error → returns null, never throws", async () => {
    const srv = serve({ port: 0, fetch: () => new Response("nope", { status: 404 }) });
    const dir = mkdtempSync(join(tmpdir(), "img-test-"));
    try {
      const missing = await downloadImage(`${srv.url}missing`, "item-7", { imagesDir: dir, allowPrivate: true });
      expect(missing).toBeNull();
    } finally {
      srv.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }

    // Connection refused: fetch a just-freed port.
    const probe = serve({ port: 0, fetch: () => new Response("ok") });
    const closedUrl = probe.url.href;
    probe.stop(true);
    const refused = await downloadImage(closedUrl, "item-8", { imagesDir: dir, timeoutMs: 1000, allowPrivate: true });
    expect(refused).toBeNull();
  });
});

describe("GET /api/wishlist/items/:id/image", () => {
  let app: TestAppHandle;
  let admin: Jar;

  beforeAll(() => {
    app = createTestApp();
    admin = app.newJar();
  });

  afterAll(async () => {
    await app.cleanup();
  });

  test("401 without session", async () => {
    const res = await fetch(`${app.baseUrl}/api/wishlist/items/any/image`);
    expect(res.status).toBe(401);
  });

  test("200 + bytes + Content-Type + Cache-Control when image exists; any signed-in user may read", async () => {
    await login(admin, "admin", "admin-password");
    const created = await admin.request("POST", "/api/wishlist/items", { title: "Pictured item" });
    const item = (await created.json()) as OwnedItem;

    mkdirSync(app.app.config.imagesDir, { recursive: true });
    writeFileSync(join(app.app.config.imagesDir, `${item.id}.png`), PNG_1X1);
    app.app.db.run("UPDATE wishlist_items SET image_path = ? WHERE id = ?", [`${item.id}.png`, item.id]);

    const res = await admin.request("GET", `/api/wishlist/items/${item.id}/image`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("private, max-age=86400");

    const raw = await admin.request("GET", `/api/wishlist/items/${item.id}/image`);
    const bytes = new Uint8Array(await raw.arrayBuffer());
    expect(bytes.length).toBe(PNG_1X1.length);
    expect(bytes[0]).toBe(0x89);

    // Lists are shared: any signed-in user may read the image.
    const bobCreated = await admin.request("POST", "/api/users", {
      username: "bob-img",
      password: "bob-img-pass",
      displayName: "Bob",
    });
    expect(bobCreated.status).toBe(201);
    const bob = app.newJar();
    await login(bob, "bob-img", "bob-img-pass");
    const bobView = await bob.request("GET", `/api/wishlist/items/${item.id}/image`);
    expect(bobView.status).toBe(200);
  });

  test("404 when the item has no image or the file is missing on disk", async () => {
    await login(admin, "admin", "admin-password");

    const noImage = await admin.request("POST", "/api/wishlist/items", { title: "No image" });
    const noImageItem = (await noImage.json()) as OwnedItem;
    const missing = await admin.request("GET", `/api/wishlist/items/${noImageItem.id}/image`);
    expect(missing.status).toBe(404);

    // Row references a file that is not on disk.
    const ghost = await admin.request("POST", "/api/wishlist/items", { title: "Ghost image" });
    const ghostItem = (await ghost.json()) as OwnedItem;
    app.app.db.run("UPDATE wishlist_items SET image_path = ? WHERE id = ?", [
      `${ghostItem.id}.png`,
      ghostItem.id,
    ]);
    const ghostView = await admin.request("GET", `/api/wishlist/items/${ghostItem.id}/image`);
    expect(ghostView.status).toBe(404);
  });

  test("deleting an item unlinks its image file (best-effort)", async () => {
    await login(admin, "admin", "admin-password");
    const created = await admin.request("POST", "/api/wishlist/items", { title: "Delete me" });
    const item = (await created.json()) as OwnedItem;

    mkdirSync(app.app.config.imagesDir, { recursive: true });
    writeFileSync(join(app.app.config.imagesDir, `${item.id}.png`), PNG_1X1);
    app.app.db.run("UPDATE wishlist_items SET image_path = ? WHERE id = ?", [`${item.id}.png`, item.id]);

    const del = await admin.request("DELETE", `/api/wishlist/items/${item.id}`);
    expect(del.status).toBe(204);
    expect(await Bun.file(join(app.app.config.imagesDir, `${item.id}.png`)).exists()).toBe(false);
  });

  test("serveItemImage works with a RELATIVE imagesDir (the default is ./data/images)", async () => {
    // join() normalizes "./data/images" to "data/images", which used to break
    // the naive startsWith guard and 404 every image in default configs.
    const dir = mkdtempSync(join(tmpdir(), "img-rel-"));
    const relativeDir = relative(process.cwd(), dir);
    try {
      writeFileSync(join(relativeDir, "rel-item.png"), PNG_1X1);
      const owner = app.app.db.query("SELECT id FROM users WHERE username = ?").get("admin") as {
        id: string;
      };
      const id = "rel-serve-item";
      app.app.db.run("INSERT INTO wishlist_items (id, user_id, title, image_path) VALUES (?, ?, ?, ?)", [
        id,
        owner.id,
        "Rel",
        "rel-item.png",
      ]);
      try {
        const ok = await serveItemImage(app.app.db, relativeDir, id);
        expect(ok.status).toBe(200);
        const bytes = new Uint8Array(await ok.arrayBuffer());
        expect(bytes.length).toBe(PNG_1X1.length);
      } finally {
        app.app.db.run("DELETE FROM wishlist_items WHERE id = ?", [id]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("downloadImage SSRF guard (private ranges)", () => {
  const PRIVATE_LITERALS = [
    "http://127.0.0.1:9/pic",
    "http://192.168.1.1:80/pic",
    "http://169.254.0.1:80/pic",
    "http://[::1]:8080/pic",
  ];

  test.each(PRIVATE_LITERALS)("literal private URL %s → null (never throws, nothing written)", async (url) => {
    const dir = mkdtempSync(join(tmpdir(), "img-ssrf-"));
    try {
      const name = await downloadImage(url, "item-ssrf", { imagesDir: dir });
      expect(name).toBeNull();
      expect(await Bun.file(join(dir, "item-ssrf.png")).exists()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("redirect target on a literal private IP → null (post-fetch final-URL check)", async () => {
    const fetchImpl: SearxngFetch = async () => {
      const res = new Response(PNG_1X1, { headers: { "Content-Type": "image/png" } });
      Object.defineProperty(res, "url", { value: "http://127.0.0.1:8080/pic" });
      return res;
    };
    const dir = mkdtempSync(join(tmpdir(), "img-ssrf-"));
    try {
      const name = await downloadImage("https://public.example.com/pic", "item-redir", {
        imagesDir: dir,
        fetchImpl,
      });
      expect(name).toBeNull();
      expect(await Bun.file(join(dir, "item-redir.png")).exists()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("allowPrivate: true → the local-server image path is untouched", async () => {
    const srv = serve({
      port: 0,
      fetch: () => new Response(PNG_1X1, { headers: { "Content-Type": "image/png" } }),
    });
    const dir = mkdtempSync(join(tmpdir(), "img-ssrf-"));
    try {
      const name = await downloadImage(`${srv.url}pic`, "item-ok", { imagesDir: dir, allowPrivate: true });
      expect(name).toBe("item-ok.png");
      expect(await Bun.file(join(dir, "item-ok.png")).exists()).toBe(true);
    } finally {
      srv.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});