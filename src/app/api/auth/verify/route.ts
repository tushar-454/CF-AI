import { verifyPin } from "@/lib/auth";

export async function POST(req: Request) {
  try {
    const headerPin = req.headers.get("x-app-pin");
    let bodyPin: string | undefined;

    try {
      const body = (await req.json()) as { pin?: string };
      if (body && typeof body.pin === "string") {
        bodyPin = body.pin;
      }
    } catch {
      // Body may be empty if pin is sent via header
    }

    const pin = headerPin || bodyPin;
    const isValid = verifyPin(pin, req);

    if (!isValid) {
      return Response.json(
        { valid: false, error: "Unauthorized. Incorrect PIN." },
        { status: 401 }
      );
    }

    return Response.json({ valid: true });
  } catch (error: any) {
    return Response.json(
      { valid: false, error: error?.message || "Verification failed" },
      { status: 500 }
    );
  }
}

export async function GET(req: Request) {
  const isValid = verifyPin(req);
  if (!isValid) {
    return Response.json(
      { valid: false, error: "Unauthorized. Incorrect PIN." },
      { status: 401 }
    );
  }
  return Response.json({ valid: true });
}
