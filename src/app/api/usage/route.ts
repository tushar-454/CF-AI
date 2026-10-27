import { NextResponse } from "next/server"
import { getUsageMetrics, MODEL_NEURON_RATES } from "@/lib/db"
import { MODELS } from "@/lib/models"
import { verifyPin } from "@/lib/auth"

export async function GET(req: Request) {
    try {
        const pin = req.headers.get("x-app-pin")
        if (!verifyPin(pin, req)) {
            return NextResponse.json(
                { error: "Unauthorized. Please enter the correct 4-digit security PIN." },
                { status: 401 }
            )
        }

        const summary = await getUsageMetrics()

        // Attach reference pricing table for all models in the catalog
        const catalogPricing = MODELS.map((m) => {
            const rate = MODEL_NEURON_RATES[m.id] || {
                inputRate: 50000,
                outputRate: 300000,
                requiredPlan: "Free",
            }
            // Calculate how many output tokens you can get on 10,000 neurons assuming zero input
            const maxOutputTokensOnFreeTier = Math.round((10000 / rate.outputRate) * 1_000_000)
            return {
                id: m.id,
                label: m.label,
                category: m.category,
                inputNeuronsPerMillionTokens: rate.inputRate,
                outputNeuronsPerMillionTokens: rate.outputRate,
                requiredPlan: rate.requiredPlan,
                maxOutputTokensOnDailyFreeAllowance: maxOutputTokensOnFreeTier,
            }
        })

        return NextResponse.json({
            status: "success",
            pricingPlan: {
                freeAllowanceDailyNeurons: 10000,
                resetTime: "00:00 UTC",
                overageCostPer1kNeurons: "$0.011",
                overageCostPer1mNeurons: "$11.00",
                rateLimits: {
                    textGenerationRpm: 300,
                    embeddingsRpm: 3000,
                },
            },
            currentUsage: summary,
            modelsCatalog: catalogPricing,
        })
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to retrieve usage stats"
        return NextResponse.json(
            {
                status: "error",
                error: msg,
            },
            { status: 500 }
        )
    }
}
