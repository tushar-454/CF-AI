import { getR2 } from "@/lib/ai";
import { getDocument } from "@/lib/db";

function inferImageMime(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "bmp":
      return "image/bmp";
    default:
      return "application/octet-stream";
  }
}

/**
 * GET /api/r2?key=uploads/... or /api/r2?id=...
 *
 * Query Params:
 * - key: R2 storage object key (e.g. 'uploads/uuid.png')
 * - id: Document ID (looks up metadata in D1 or falls back to prefix lookup)
 * - action=link or format=json: Returns JSON payload with the direct image link
 * - Otherwise: Serves the private R2 image stream directly with appropriate caching and content type headers
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const key = url.searchParams.get("key")?.trim();
    const id = url.searchParams.get("id")?.trim();
    const format = url.searchParams.get("format")?.toLowerCase();
    const action = url.searchParams.get("action")?.toLowerCase();

    if (!key && !id) {
      return Response.json(
        { error: "Missing required query parameter: 'key' or 'id'" },
        { status: 400 }
      );
    }

    const r2 = getR2();
    let targetKey = key;
    let mimeType: string | undefined;
    let fileName: string | undefined;

    // If ID provided without key, or to resolve metadata
    if (id) {
      const doc = await getDocument(id).catch(() => null);
      if (doc) {
        targetKey = doc.r2_key;
        mimeType = doc.mime;
        fileName = doc.name;
      } else if (!targetKey) {
        targetKey = `uploads/${id}`;
      }
    }

    // If consumer requested the JSON link info
    if (format === "json" || action === "link") {
      const resolvedKey = targetKey || `uploads/${id}`;
      const imageLink = `/api/r2?key=${encodeURIComponent(resolvedKey)}`;
      const fileLink = id ? `/api/files/${id}` : imageLink;

      return Response.json({
        success: true,
        key: resolvedKey,
        url: imageLink,
        fileUrl: fileLink,
        name: fileName,
        mime: mimeType || inferImageMime(resolvedKey),
      });
    }

    // Otherwise, fetch and stream the object directly from private R2
    let object = targetKey ? await r2.get(targetKey) : null;

    // Fallbacks if targetKey didn't match immediately
    if (!object && id) {
      object = await r2.get(`uploads/${id}`);
      if (!object) {
        // Try prefix search in uploads/ in case extension was appended
        try {
          const list = await r2.list({ prefix: `uploads/${id}`, limit: 1 });
          if (list.objects.length > 0) {
            targetKey = list.objects[0].key;
            object = await r2.get(targetKey);
          }
        } catch {
          // ignore
        }
      }
    }

    if (!object) {
      return Response.json(
        { error: `File not found in R2 storage for key: ${targetKey || id}` },
        { status: 404 }
      );
    }

    const resolvedMime =
      mimeType ||
      object.httpMetadata?.contentType ||
      inferImageMime(targetKey || "file.png");

    const headers = new Headers();
    headers.set("Content-Type", resolvedMime);
    if (object.size) {
      headers.set("Content-Length", object.size.toString());
    }
    const resolvedName = fileName || targetKey?.split("/").pop() || "image";
    headers.set("Content-Disposition", `inline; filename="${encodeURIComponent(resolvedName)}"`);
    headers.set("Cache-Control", "public, max-age=31536000, immutable");

    return new Response(object.body, { headers });
  } catch (error: any) {
    console.error("Error in GET /api/r2:", error);
    const isBindingError = error?.name === "R2BindingError";
    return Response.json(
      { error: error?.message || "Failed to retrieve R2 object", isBindingError },
      { status: isBindingError ? 503 : 500 }
    );
  }
}

/**
 * POST /api/r2
 * Accepts { key?: string, id?: string } and returns the image link
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { key?: string; id?: string };
    const key = body.key?.trim();
    const id = body.id?.trim();

    if (!key && !id) {
      return Response.json(
        { error: "Missing required field: 'key' or 'id'" },
        { status: 400 }
      );
    }

    let targetKey = key;
    let fileName: string | undefined;
    let mimeType: string | undefined;

    if (id) {
      const doc = await getDocument(id).catch(() => null);
      if (doc) {
        targetKey = doc.r2_key;
        fileName = doc.name;
        mimeType = doc.mime;
      } else if (!targetKey) {
        targetKey = `uploads/${id}`;
      }
    }

    const resolvedKey = targetKey || `uploads/${id}`;
    const imageLink = `/api/r2?key=${encodeURIComponent(resolvedKey)}`;
    const fileLink = id ? `/api/files/${id}` : imageLink;

    return Response.json({
      success: true,
      key: resolvedKey,
      url: imageLink,
      fileUrl: fileLink,
      name: fileName,
      mime: mimeType || inferImageMime(resolvedKey),
    });
  } catch (error: any) {
    return Response.json(
      { error: error?.message || "Failed to process R2 request" },
      { status: 500 }
    );
  }
}
