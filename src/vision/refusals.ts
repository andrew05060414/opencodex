/*
 * Refusal wording adapted from yetone/magpie, internal/gateway/vision.go.
 * MIT License
 * Copyright (c) 2026 yetone
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { OcxProviderConfig } from "../types";

export interface VisionRefusal {
  provider: string;
  modelId: string;
  detectedAt: string;
}

const MAX_REFUSALS = 512;
const refusals = new Map<string, VisionRefusal>();

// A name can be reused for a different endpoint without carrying the old endpoint's verdict.
function key(providerName: string, provider: OcxProviderConfig, modelId: string): string {
  return JSON.stringify([providerName, provider.adapter, provider.baseUrl, modelId]);
}

export function visionRefusal(providerName: string, provider: OcxProviderConfig, modelId: string): VisionRefusal | undefined {
  return refusals.get(key(providerName, provider, modelId));
}

export function rememberVisionRefusal(providerName: string, provider: OcxProviderConfig, modelId: string): void {
  const identity = key(providerName, provider, modelId);
  if (refusals.has(identity)) return;
  if (refusals.size >= MAX_REFUSALS) refusals.delete(refusals.keys().next().value!);
  refusals.set(identity, { provider: providerName, modelId, detectedAt: new Date().toISOString() });
}

export function forgetVisionRefusal(providerName: string, provider: OcxProviderConfig, modelId: string): boolean {
  return refusals.delete(key(providerName, provider, modelId));
}

export function resetVisionRefusals(): void {
  refusals.clear();
}

export function isImageCapabilityRefusal(status: number, body: string): boolean {
  if (![400, 415, 422].includes(status)) return false;
  let message = body;
  try {
    const parsed = JSON.parse(body);
    message = typeof parsed.error?.message === "string" ? parsed.error.message
      : typeof parsed.message === "string" ? parsed.message : "";
  } catch { /* Some relays return plain text. */ }
  if (/invalid image|image (?:data|format|size)|(?:unsupported|invalid) (?:image |mime )?(?:format|encoding)|too large|safety|content policy|temporar|try again|overloaded|timeout|service unavailable/i.test(message)) return false;
  return /image_url is only supported by certain models|model only supports text input|unknown variant [`'"\\]*(?:image_url|input_image|image)\b|no endpoints found that support image|not a multi-?modal model|(?:does not|doesn't|do not|don't|cannot|can't|unable to) (?:support|accept|process|handle|take|read) (?:the )?(?:images?\b|vision\b|multi-?modal\b)|\b(?:images?|vision|multi-?modal|image_url|input_image)(?: (?:input|inputs|content|parts?))? (?:is |are )?(?:not supported|unsupported|not enabled|not allowed)|不支持(?:图片|图像|多模态|视觉|识图)/i.test(message);
}
