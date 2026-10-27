import { createDocument } from "@/lib/db";
import { getAi, getR2 } from "@/lib/ai";
import { indexDocument } from "@/lib/rag";
import { env } from "cloudflare:workers";
import { verifyPin } from "@/lib/auth";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const TEXT_MIME_PATTERNS = [
  /^text\//,
  /application\/json/,
  /application\/javascript/,
  /application\/typescript/,
  /application\/xml/,
  /application\/x-sh/,
  /application\/x-yaml/,
  /application\/sql/,
  /application\/csv/,
];

function isTextFile(mime: string, filename: string): boolean {
  if (TEXT_MIME_PATTERNS.some((pat) => pat.test(mime))) return true;
  const ext = filename.split(".").pop()?.toLowerCase();
  const textExtensions = [
    "txt",
    "md",
    "markdown",
    "json",
    "js",
    "jsx",
    "ts",
    "tsx",
    "css",
    "html",
    "htm",
    "csv",
    "yaml",
    "yml",
    "py",
    "rs",
    "go",
    "java",
    "c",
    "cpp",
    "h",
    "sh",
    "sql",
    "env",
    "xml",
  ];
  return ext ? textExtensions.includes(ext) : false;
}

export async function POST(req: Request) {
  try {
    const pin = req.headers.get("x-app-pin");
    if (!verifyPin(pin, req)) {
      return Response.json({ error: "Unauthorized. Please enter the correct 4-digit security PIN." }, { status: 401 });
    }

    const formData = await req.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      return Response.json({ error: "No file provided in form-data field 'file'" }, { status: 400 });
    }

    if (file.size > MAX_FILE_SIZE) {
      return Response.json(
        { error: `File size exceeds the 10 MB limit (${(file.size / (1024 * 1024)).toFixed(1)} MB)` },
        { status: 413 }
      );
    }

    const documentId = crypto.randomUUID();
    const ext = file.name.split(".").pop() || "bin";
    const r2Key = `uploads/${documentId}.${ext}`;
    const isImage = file.type.startsWith("image/");
    const isText = isTextFile(file.type, file.name);

    const arrayBuffer = await file.arrayBuffer();

    // Store in R2 bucket
    const r2 = getR2();
    await r2.put(r2Key, arrayBuffer, {
      httpMetadata: {
        contentType: file.type || "application/octet-stream",
      },
      customMetadata: {
        originalName: file.name,
        documentId,
      },
    });

    let extractedText = "";
    let status: "ready" | "image" | "processing" | "error" = isImage ? "image" : "ready";

    if (isText) {
      try {
        const decoder = new TextDecoder("utf-8");
        extractedText = decoder.decode(arrayBuffer);

        // If Vectorize and AI bindings are available, index the text
        const ai = (env as any)?.AI;
        const vectorize = (env as any)?.VECTORIZE;
        if (ai && vectorize && extractedText.trim()) {
          try {
            await indexDocument(ai, vectorize, documentId, file.name, extractedText);
          } catch (ragErr) {
            console.warn("Could not index document in Vectorize (likely placeholder config):", ragErr);
          }
        }
      } catch (decodeErr) {
        console.warn("Failed to decode text file:", decodeErr);
      }
    }

    // Record document in D1
    try {
      await createDocument({
        id: documentId,
        name: file.name,
        r2_key: r2Key,
        mime: file.type || "application/octet-stream",
        size: file.size,
        status,
        created_at: Date.now(),
      });
    } catch (dbErr: any) {
      console.warn("D1 could not record document:", dbErr?.message);
    }

    return Response.json({
      id: documentId,
      name: file.name,
      mime: file.type || "application/octet-stream",
      size: file.size,
      r2_key: r2Key,
      isImage,
      status,
      textContent: extractedText ? extractedText.slice(0, 4000) : undefined, // Provide preview/context
    });
  } catch (error: any) {
    console.error("Error in POST /api/upload:", error);
    const isBindingError =
      error?.name === "R2BindingError" ||
      error?.name === "DatabaseBindingError" ||
      error?.message?.includes("REPLACE_WITH_");

    return Response.json(
      {
        error: error?.message || "File upload failed",
        isBindingError: Boolean(isBindingError),
      },
      { status: isBindingError ? 503 : 500 }
    );
  }
}
