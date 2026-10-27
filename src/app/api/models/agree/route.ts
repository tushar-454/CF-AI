import { acceptModelAgreement } from "@/lib/ai";
import { verifyPin } from "@/lib/auth";

export async function POST(req: Request) {
  try {
    const pin = req.headers.get("x-app-pin");
    if (!verifyPin(pin, req)) {
      return Response.json(
        { error: "Unauthorized. Please enter the correct 4-digit security PIN." },
        { status: 401 }
      );
    }

    const body = (await req.json().catch(() => ({}))) as { model?: string };
    const model = body?.model || "@cf/meta/llama-3.2-11b-vision-instruct";

    const success = await acceptModelAgreement(model);
    return Response.json({ success, model });
  } catch (error: any) {
    console.error("Error in POST /api/models/agree:", error);
    return Response.json(
      { error: error?.message || "Failed to submit model license agreement" },
      { status: 500 }
    );
  }
}
