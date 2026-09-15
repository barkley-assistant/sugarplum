import { Database } from "bun:sqlite";
import { requireSession } from "../auth/middleware";
import { serveItemImage } from "../images";

export function imageRoutes(db: Database, imagesDir: string) {
  return {
    "/api/wishlist/items/:id/image": {
      GET: requireSession(db, (req) => serveItemImage(db, imagesDir, req.params.id)),
    },
  };
}