import { DEFAULT_MODEL_ID, MODELS } from "@/lib/models";

export function GET() {
  return Response.json({
    models: MODELS,
    defaultModel: DEFAULT_MODEL_ID,
  });
}
