import { deleteDocument, getDocument } from "@/lib/db";
import { getR2 } from "@/lib/ai";
import { deleteDocumentVectors } from "@/lib/rag";
import { env } from "cloudflare:workers";
import { verifyPin } from "@/lib/auth";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const doc = await getDocument(id);
    const r2 = getR2();

    const r2Key = doc?.r2_key || `uploads/${id}`;
    const object = await r2.get(r2Key);

    if (!object) {
      return Response.json({ error: "File not found in storage" }, { status: 404 });
    }

    const headers = new Headers();
    headers.set("Content-Type", doc?.mime || object.httpMetadata?.contentType || "application/octet-stream");
    if (object.size) {
      headers.set("Content-Length", object.size.toString());
    }
    const filename = doc?.name || "file";
    headers.set("Content-Disposition", `inline; filename="${encodeURIComponent(filename)}"`);
    headers.set("Cache-Control", "public, max-age=31536000, immutable");

    return new Response(object.body, { headers });
  } catch (error: any) {
    console.error("Error in GET /api/files/[id]:", error);
    const isBindingError = error?.name === "R2BindingError";
    return Response.json(
      { error: error?.message || "Failed to retrieve file", isBindingError },
      { status: isBindingError ? 503 : 500 }
    );
  }
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const pin = req.headers.get("x-app-pin");
    if (!verifyPin(pin)) {
      return Response.json({ error: "Unauthorized. Please enter the correct 4-digit security PIN." }, { status: 401 });
    }

    const { id } = await context.params;
    const doc = await getDocument(id);

    // 1. Delete from R2
    try {
      const r2 = getR2();
      const r2Key = doc?.r2_key || `uploads/${id}`;
      await r2.delete(r2Key);
    } catch (r2Err) {
      console.warn("Could not delete from R2:", r2Err);
    }

    // 2. Delete vectors from Vectorize
    try {
      const vectorize = (env as any)?.VECTORIZE;
      if (vectorize) {
        await deleteDocumentVectors(vectorize, id);
      }
    } catch (vecErr) {
      console.warn("Could not delete vectors from Vectorize:", vecErr);
    }

    // 3. Delete from D1
    await deleteDocument(id);

    return Response.json({ success: true, deletedId: id });
  } catch (error: any) {
    console.error("Error in DELETE /api/files/[id]:", error);
    const isBindingError = error?.name === "DatabaseBindingError" || error?.name === "R2BindingError";
    return Response.json(
      { error: error?.message || "Failed to delete file", isBindingError },
      { status: isBindingError ? 503 : 500 }
    );
  }
}
