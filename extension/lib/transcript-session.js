import {
  buildPolishInputWithOverlap,
  mergePolishedResult,
  POLISH_BATCH_SIZE,
  POLISH_FAILURE_COOLDOWN_MS,
  countCompletedSentences,
  isImplausiblePolish,
  isPolishCooldownActive,
  joinDisplay,
  normalizePolishedParagraphs,
  takeAllCompletedAndRest,
  takeCompletedBatch,
} from "./polish-text.js";
import { polishTranscriptText } from "./polish.js";

export function createTranscriptSession() {
  return {
    polishedText: "",
    pendingRawText: "",
    fullRawText: "",
    polishedSentenceCount: 0,
    polishInFlight: false,
    polishFlushQueued: false,
    polishFailure: null,
    lastPolishError: "",
    lastForceFlushAt: 0,
    generation: 0,
  };
}

export function resetTranscriptSession(session) {
  session.polishedText = "";
  session.pendingRawText = "";
  session.fullRawText = "";
  session.polishedSentenceCount = 0;
  session.polishFlushQueued = false;
  session.polishFailure = null;
  session.lastPolishError = "";
  session.lastForceFlushAt = 0;
  session.generation += 1;
  // Leave polishInFlight alone until the stale request returns.
}

export function getTranscriptSnapshot(session, { polishEnabled = true } = {}) {
  const pendingCompleted = countCompletedSentences(session.pendingRawText);
  const totalCompleted = session.polishedSentenceCount + pendingCompleted;
  const display = joinDisplay(session.polishedText, session.pendingRawText);
  const status =
    polishEnabled && session.lastPolishError ? session.lastPolishError : "";

  return {
    display,
    fullRawText: session.fullRawText,
    status,
    polishEnabled: Boolean(polishEnabled),
    polishedSentenceCount: session.polishedSentenceCount,
    totalCompleted,
    polishInFlight: session.polishInFlight,
  };
}

export function appendTranscriptChunk(session, text) {
  if (!text) {
    return;
  }
  session.pendingRawText += text;
  session.fullRawText += text;
}

export async function maybePolishTranscriptSession(
  session,
  { forceAll = false, getApiKey, onChange, targetLanguage = "en" },
) {
  if (forceAll) {
    const now = Date.now();
    if (
      !session.pendingRawText.trim() ||
      now - session.lastForceFlushAt < 2000
    ) {
      return false;
    }
    session.lastForceFlushAt = now;
  } else if (
    isPolishCooldownActive(session.polishFailure, {
      now: Date.now(),
      pendingCompleted: countCompletedSentences(session.pendingRawText),
      cooldownMs: POLISH_FAILURE_COOLDOWN_MS,
      batchSize: POLISH_BATCH_SIZE,
    })
  ) {
    return false;
  }

  if (session.polishInFlight) {
    session.polishFlushQueued = session.polishFlushQueued || Boolean(forceAll);
    return false;
  }

  const snapshot = session.pendingRawText;
  const slice = forceAll
    ? takeAllCompletedAndRest(snapshot)
    : takeCompletedBatch(snapshot, POLISH_BATCH_SIZE);
  if (!slice || !slice.batchText.trim()) {
    if (forceAll) {
      session.pendingRawText = slice?.rest ?? session.pendingRawText;
    }
    return false;
  }

  const generation = session.generation;
  session.polishInFlight = true;
  onChange?.();
  try {
    const { polishInput, overlapParagraphs } = buildPolishInputWithOverlap(
      session.polishedText,
      slice.batchText,
    );
    const apiKey = await getApiKey();
    const cleaned = normalizePolishedParagraphs(
      await polishTranscriptText({
        text: polishInput,
        apiKey,
        targetLanguage,
        hasOverlap: overlapParagraphs > 0,
      }),
    );
    if (generation !== session.generation) {
      return false;
    }
    if (isImplausiblePolish(cleaned, polishInput)) {
      throw new Error("Bản chuẩn hóa bất thường — giữ bản thô.");
    }
    session.polishedText = mergePolishedResult(
      session.polishedText,
      cleaned,
      overlapParagraphs,
    );
    session.polishedSentenceCount += countCompletedSentences(slice.batchText);
    session.pendingRawText = session.pendingRawText.slice(
      snapshot.length - slice.rest.length,
    );
    session.polishFailure = null;
    session.lastPolishError = "";
    return true;
  } catch (error) {
    if (generation !== session.generation) {
      return false;
    }
    session.lastPolishError =
      error instanceof Error ? error.message : String(error);
    session.polishFailure = {
      at: Date.now(),
      pendingCompleted: countCompletedSentences(session.pendingRawText),
    };
    return false;
  } finally {
    if (generation === session.generation) {
      session.polishInFlight = false;
      onChange?.();
      if (session.polishFlushQueued) {
        session.polishFlushQueued = false;
        session.lastForceFlushAt = 0;
        void maybePolishTranscriptSession(session, {
          forceAll: true,
          getApiKey,
          onChange,
          targetLanguage,
        });
      } else if (!forceAll) {
        void maybePolishTranscriptSession(session, {
          forceAll: false,
          getApiKey,
          onChange,
          targetLanguage,
        });
      }
    } else {
      session.polishInFlight = false;
      onChange?.();
    }
  }
}
