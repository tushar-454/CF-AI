"use client";

import React, { useEffect, useState } from "react";
import { XIcon, ActivityIcon } from "./Icons";
import { getAuthHeaders } from "@/lib/auth";

interface ModelUsage {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  estimatedNeurons: number;
  requiredPlan: string;
}

interface CatalogModel {
  id: string;
  label: string;
  category: string;
  inputNeuronsPerMillionTokens: number;
  outputNeuronsPerMillionTokens: number;
  requiredPlan: string;
  maxOutputTokensOnDailyFreeAllowance: number;
}

interface UsageData {
  status: string;
  pricingPlan: {
    freeAllowanceDailyNeurons: number;
    resetTime: string;
    overageCostPer1kNeurons: string;
    overageCostPer1mNeurons: string;
    rateLimits: {
      textGenerationRpm: number;
      embeddingsRpm: number;
    };
  };
  currentUsage: {
    dateUtc: string;
    resetAtUtc: string;
    dailyFreeNeuronsLimit: number;
    estimatedNeuronsUsedToday: number;
    remainingNeuronsToday: number;
    percentUsed: number;
    totalRequestsToday: number;
    totalInputTokensToday: number;
    totalOutputTokensToday: number;
    allTimeMessages: number;
    allTimeDocuments: number;
    byModel: Record<string, ModelUsage>;
  };
  modelsCatalog: CatalogModel[];
}

interface UsageModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function UsageModal({ isOpen, onClose }: UsageModalProps) {
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchUsage = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/usage", { headers: getAuthHeaders() });
      if (!res.ok) throw new Error("Failed to load usage data");
      const json = await res.json();
      setData(json as UsageData);
    } catch (err: any) {
      setError(err.message || "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchUsage();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const current = data?.currentUsage;
  const pricing = data?.pricingPlan;
  const percent = current ? Math.min(100, Math.max(0, current.percentUsed)) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-200">
      <div
        className="relative w-full max-w-2xl bg-[var(--surface-bg)] border border-[var(--border)] rounded-2xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden text-[var(--text-primary)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-[var(--badge-bg)] text-[var(--accent)] flex items-center justify-center">
              <ActivityIcon size={18} />
            </div>
            <div>
              <h2 className="text-base font-semibold">Workers AI Usage & Limits</h2>
              <p className="text-xs text-[var(--text-muted)]">
                Daily free allowance: 10,000 Neurons (resets at 00:00 UTC)
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--button-hover)] transition-colors"
          >
            <XIcon size={18} />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 overflow-y-auto space-y-6">
          {loading ? (
            <div className="py-12 flex flex-col items-center justify-center text-[var(--text-muted)]">
              <div className="w-6 h-6 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin mb-3" />
              <p className="text-xs">Calculating daily tokens and neurons...</p>
            </div>
          ) : error ? (
            <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs text-center">
              {error}
            </div>
          ) : current ? (
            <>
              {/* Daily Free Allowance Meter */}
              <div className="p-4 rounded-xl bg-[var(--main-bg)] border border-[var(--border)] space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm">Today&apos;s Free Quota</span>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
                      Active
                    </span>
                  </div>
                  <span className="font-mono text-xs text-[var(--text-muted)]">
                    {current.estimatedNeuronsUsedToday.toLocaleString()} / {current.dailyFreeNeuronsLimit.toLocaleString()} Neurons ({percent}%)
                  </span>
                </div>

                {/* Progress bar */}
                <div className="w-full h-2.5 rounded-full bg-[var(--border)] overflow-hidden">
                  <div
                    className={`h-full transition-all duration-500 ${
                      percent > 85 ? "bg-amber-500" : "bg-[var(--accent)]"
                    }`}
                    style={{ width: `${Math.max(2, percent)}%` }}
                  />
                </div>

                <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)]">
                  <span>Remaining: <strong>{current.remainingNeuronsToday.toLocaleString()}</strong> Neurons</span>
                  <span>Resets at: {new Date(current.resetAtUtc).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}</span>
                </div>
              </div>

              {/* Stats Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-3 rounded-xl bg-[var(--main-bg)] border border-[var(--border)]">
                  <span className="text-[10px] font-medium text-[var(--text-muted)] uppercase tracking-wider">
                    Today&apos;s Requests
                  </span>
                  <p className="text-lg font-semibold mt-0.5">{current.totalRequestsToday}</p>
                </div>
                <div className="p-3 rounded-xl bg-[var(--main-bg)] border border-[var(--border)]">
                  <span className="text-[10px] font-medium text-[var(--text-muted)] uppercase tracking-wider">
                    Input Tokens
                  </span>
                  <p className="text-lg font-semibold mt-0.5">{current.totalInputTokensToday.toLocaleString()}</p>
                </div>
                <div className="p-3 rounded-xl bg-[var(--main-bg)] border border-[var(--border)]">
                  <span className="text-[10px] font-medium text-[var(--text-muted)] uppercase tracking-wider">
                    Output Tokens
                  </span>
                  <p className="text-lg font-semibold mt-0.5">{current.totalOutputTokensToday.toLocaleString()}</p>
                </div>
                <div className="p-3 rounded-xl bg-[var(--main-bg)] border border-[var(--border)]">
                  <span className="text-[10px] font-medium text-[var(--text-muted)] uppercase tracking-wider">
                    All-Time Messages
                  </span>
                  <p className="text-lg font-semibold mt-0.5">{current.allTimeMessages}</p>
                </div>
              </div>

              {/* Per-Model Usage Breakdown */}
              {Object.keys(current.byModel).length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                    Today&apos;s Usage by Model
                  </h3>
                  <div className="border border-[var(--border)] rounded-xl overflow-hidden text-xs">
                    <table className="w-full text-left">
                      <thead className="bg-[var(--main-bg)] text-[var(--text-muted)] border-b border-[var(--border)] font-medium">
                        <tr>
                          <th className="py-2 px-3">Model</th>
                          <th className="py-2 px-3 text-right">Requests</th>
                          <th className="py-2 px-3 text-right">Est. Tokens</th>
                          <th className="py-2 px-3 text-right">Est. Neurons</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--border)]">
                        {Object.values(current.byModel).map((bm) => (
                          <tr key={bm.model} className="hover:bg-[var(--button-hover)]">
                            <td className="py-2 px-3 font-mono text-[11px] truncate max-w-[200px]" title={bm.model}>
                              {bm.model.replace("@cf/", "")}
                            </td>
                            <td className="py-2 px-3 text-right">{bm.requests}</td>
                            <td className="py-2 px-3 text-right font-mono text-[11px]">
                              {(bm.inputTokens + bm.outputTokens).toLocaleString()}
                            </td>
                            <td className="py-2 px-3 text-right font-mono text-[11px] font-semibold text-[var(--accent)]">
                              {bm.estimatedNeurons.toLocaleString()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Model Pricing Reference Table */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                    Model Neuron Rates & Free Tier Budget
                  </h3>
                  <span className="text-[11px] text-[var(--text-muted)]">
                    Extra: {pricing?.overageCostPer1kNeurons} / 1k Neurons
                  </span>
                </div>

                <div className="border border-[var(--border)] rounded-xl overflow-hidden text-xs max-h-56 overflow-y-auto">
                  <table className="w-full text-left">
                    <thead className="bg-[var(--main-bg)] text-[var(--text-muted)] border-b border-[var(--border)] font-medium sticky top-0">
                      <tr>
                        <th className="py-2 px-3">Model</th>
                        <th className="py-2 px-3">Plan</th>
                        <th className="py-2 px-3 text-right">Input / 1M</th>
                        <th className="py-2 px-3 text-right">Output / 1M</th>
                        <th className="py-2 px-3 text-right">Free Capacity</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--border)]">
                      {data?.modelsCatalog.map((m) => (
                        <tr key={m.id} className="hover:bg-[var(--button-hover)]">
                          <td className="py-2 px-3">
                            <div className="font-medium text-[11px]">{m.label}</div>
                            <div className="text-[10px] text-[var(--text-muted)] font-mono">{m.category}</div>
                          </td>
                          <td className="py-2 px-3">
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                m.requiredPlan === "Free"
                                  ? "bg-emerald-500/10 text-emerald-500"
                                  : "bg-blue-500/10 text-blue-400"
                              }`}
                            >
                              {m.requiredPlan}
                            </span>
                          </td>
                          <td className="py-2 px-3 text-right font-mono text-[10px]">
                            {m.inputNeuronsPerMillionTokens.toLocaleString()}
                          </td>
                          <td className="py-2 px-3 text-right font-mono text-[10px]">
                            {m.outputNeuronsPerMillionTokens.toLocaleString()}
                          </td>
                          <td className="py-2 px-3 text-right font-mono text-[10px] font-semibold text-emerald-500">
                            ~{m.maxOutputTokensOnDailyFreeAllowance.toLocaleString()} tokens
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Cloudflare Dashboard Links */}
              <div className="pt-2 border-t border-[var(--border)] flex flex-wrap items-center justify-between gap-3 text-xs text-[var(--text-muted)]">
                <a
                  href="https://dash.cloudflare.com/7ab77eaa396c9a6435e5659a299e07cf/workers-and-pages/ai"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--accent)] hover:underline inline-flex items-center gap-1 font-medium"
                >
                  Cloudflare AI Dashboard →
                </a>
                <a
                  href="https://developers.cloudflare.com/workers-ai/models/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--accent)] hover:underline inline-flex items-center gap-1 font-medium"
                >
                  Official Model Catalog Docs →
                </a>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
