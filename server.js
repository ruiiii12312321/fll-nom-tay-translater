require("dotenv").config();
const express = require("express");
const path = require("path");
const OpenAI = require("openai");
const { loadLocaleConfig, DEFAULT_LOCALE } = require("./src/i18n");
const { createTrainingModule } = require("./src/training/module");
const { createRateLimiter } = require("./src/rate-limit");

const port = process.env.PORT || 3000;

function logException(context, error, metadata = {}) {
  const payload = {
    level: "error",
    context,
    code: error && error.code ? error.code : "UNKNOWN",
    status: error && error.status ? error.status : undefined,
    message: error && error.message ? error.message : "Unknown error",
    stack: error && error.stack ? error.stack : "",
    metadata,
    timestamp: new Date().toISOString()
  };
  console.error(JSON.stringify(payload, null, 2));
}

function getOpenAIClient(requestApiKey) {
  const apiKey = process.env.OPENAI_API_KEY || requestApiKey;
  if (!apiKey) {
    const error = new Error("Missing OpenAI API key. Enter it in the web app or set OPENAI_API_KEY.");
    error.code = "AUTH_MISSING_API_KEY";
    throw error;
  }
  return new OpenAI({
    apiKey
  });
}

function isValidApiKeyFormat(apiKey) {
  if (!apiKey || typeof apiKey !== "string") {
    return false;
  }
  const value = apiKey.trim();
  if (!value || value.includes(" ")) {
    return false;
  }
  return /^sk-[A-Za-z0-9_\-]{20,}$/.test(value);
}

function normalizeChatMessages(messages) {
  if (!Array.isArray(messages)) {
    return { ok: false, error: "messages must be an array." };
  }
  if (messages.length === 0) {
    return { ok: false, error: "messages cannot be empty." };
  }
  if (messages.length > 20) {
    return { ok: false, error: "messages is too long." };
  }
  const normalized = [];
  for (const msg of messages) {
    const role = msg && typeof msg.role === "string" ? msg.role.trim() : "";
    const content = msg && typeof msg.content === "string" ? msg.content : "";
    if (!role || !["system", "user", "assistant"].includes(role)) {
      return { ok: false, error: "Invalid message role." };
    }
    if (!content || !content.trim()) {
      return { ok: false, error: "Message content is required." };
    }
    if (content.length > 8000) {
      return { ok: false, error: "Message content is too large." };
    }
    normalized.push({ role, content: content.trim() });
  }
  return { ok: true, messages: normalized };
}

function extractTranslationOnly(modelText) {
  const fullText = (modelText || "").trim();
  if (!fullText) {
    return "";
  }
  const match = fullText.match(/(?:Vietnamese Translation|Translation|Translated Text):\s*([\s\S]*)$/i);
  if (!match) {
    return fullText;
  }
  return match[1].trim();
}

async function translateNomHanToVietnamese(text, requestApiKey) {
  return translateNomHan(text, requestApiKey, DEFAULT_LOCALE, "Vietnamese");
}

async function translateNomHan(text, requestApiKey, locale, targetLanguage) {
  const localeConfig = loadLocaleConfig(locale);
  const destination = targetLanguage || "Vietnamese";
  const openai = getOpenAIClient(requestApiKey);
  const response = await openai.responses.create({
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: localeConfig.prompts.system
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `${localeConfig.prompts.userTemplate}\n\nTarget Language:\n${destination}\n\nDetected Text:\n${text.trim()}`
          }
        ]
      }
    ]
  });
  const fullResult = (response.output_text || "").trim();
  return {
    fullResult,
    translatedText: extractTranslationOnly(fullResult),
    localeConfig
  };
}

async function validateOpenAIKey(requestApiKey) {
  const openai = getOpenAIClient(requestApiKey);
  await openai.models.list();
  return { ok: true };
}

async function chatCompletion(messages, requestApiKey) {
  const openai = getOpenAIClient(requestApiKey);
  const response = await openai.responses.create({
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    input: messages.map((msg) => ({
      role: msg.role,
      content: [
        {
          type: "input_text",
          text: msg.content
        }
      ]
    }))
  });
  return (response.output_text || "").trim();
}

function resolveErrorCode(error) {
  if (!error) {
    return "UNKNOWN_ERROR";
  }
  if (error.code === "AUTH_MISSING_API_KEY") {
    return "AUTH_MISSING_API_KEY";
  }
  if (error.code === "KEY_INVALID_FORMAT") {
    return "KEY_INVALID_FORMAT";
  }
  if (error.status === 401 || error.status === 403) {
    return "AUTH_INVALID_API_KEY";
  }
  if (error.status === 429) {
    return "RATE_LIMIT_EXCEEDED";
  }
  if (error.code === "ETIMEDOUT" || error.code === "ECONNRESET") {
    return "NETWORK_TIMEOUT";
  }
  return "TRANSLATION_SERVICE_ERROR";
}

function createApp(options = {}) {
  const translateHandler = options.translateHandler || translateNomHan;
  const validateKeyHandler = options.validateKeyHandler || validateOpenAIKey;
  const chatHandler = options.chatHandler || chatCompletion;
  const trainingModule =
    options.trainingModule ||
    createTrainingModule({
      enabled: options.enableTrainingScheduler === true,
      schedulerIntervalMs: options.trainingIntervalMs
    });
  const app = express();
  app.locals.trainingModule = trainingModule;
  app.use(express.json({ limit: "10mb" }));
  app.use(express.static(path.join(__dirname, "public")));

  const apiRateLimiter =
    typeof options.apiRateLimiter === "function"
      ? options.apiRateLimiter
      : createRateLimiter({
          max: process.env.RATE_LIMIT_MAX || 30,
          windowMs: process.env.RATE_LIMIT_WINDOW_MS || 60_000,
          keyPrefix: "api"
        });

  app.post("/api/chat", apiRateLimiter, async (req, res) => {
    const requestApiKey = (req.get("x-openai-api-key") || "").trim();
    const body = req.body || {};
    const normalized = normalizeChatMessages(body.messages);
    if (!normalized.ok) {
      return res.status(400).json({ error: normalized.error });
    }
    try {
      const text = await chatHandler(normalized.messages, requestApiKey);
      return res.json({ text });
    } catch (error) {
      const errorCode = resolveErrorCode(error);
      logException("chat_failed", error, {
        endpoint: "/api/chat",
        errorCode
      });
      const status =
        errorCode === "AUTH_MISSING_API_KEY"
          ? 500
          : errorCode === "AUTH_INVALID_API_KEY" || errorCode === "KEY_INVALID_FORMAT"
            ? 502
            : errorCode === "RATE_LIMIT_EXCEEDED"
              ? 429
              : errorCode === "NETWORK_TIMEOUT"
                ? 504
                : 502;
      return res.status(status).json({
        error: "Chat request failed.",
        errorCode
      });
    }
  });

  app.post("/api/validate-key", async (req, res) => {
    const requestApiKey = (req.get("x-openai-api-key") || "").trim();
    const effectiveKey = process.env.OPENAI_API_KEY || requestApiKey;
    if (!isValidApiKeyFormat(effectiveKey)) {
      return res.status(400).json({
        ok: false,
        errorCode: "KEY_INVALID_FORMAT",
        message: "Invalid OpenAI API key format."
      });
    }
    try {
      await validateKeyHandler(effectiveKey);
      return res.json({ ok: true });
    } catch (error) {
      const errorCode = resolveErrorCode(error);
      logException("validate_key_failed", error, {
        endpoint: "/api/validate-key",
        errorCode
      });
      if (errorCode === "AUTH_INVALID_API_KEY" || errorCode === "AUTH_MISSING_API_KEY") {
        return res.status(403).json({ ok: false, errorCode: "AUTH_INVALID_API_KEY" });
      }
      if (error.status === 429) {
        return res.status(429).json({ ok: false, errorCode: "RATE_LIMIT_EXCEEDED" });
      }
      if (errorCode === "NETWORK_TIMEOUT") {
        return res.status(504).json({ ok: false, errorCode: "NETWORK_TIMEOUT" });
      }
      return res.status(500).json({ ok: false, errorCode: "VALIDATE_KEY_FAILED" });
    }
  });

  app.post("/api/training/feedback", (req, res) => {
    const payload = req.body || {};
    const response = trainingModule.collectInteraction({
      sourceText: payload.sourceText,
      modelOutput: payload.modelOutput,
      correctedOutput: payload.correctedOutput,
      targetLanguage: payload.targetLanguage,
      locale: payload.locale,
      sourceType: payload.sourceType || "user_feedback",
      userAccepted: payload.userAccepted,
      latencyMs: payload.latencyMs,
      region: payload.region
    });
    if (!response.ok) {
      return res.status(400).json({
        ok: false,
        error: response.error
      });
    }
    return res.json({
      ok: true,
      interactionId: response.interactionId
    });
  });

  app.post("/api/training/run", async (req, res) => {
    const trigger = (req.body && req.body.trigger) || "manual";
    const result = await trainingModule.runTrainingCycle(trigger);
    return res.json({
      ok: result.ok,
      status: result.status,
      job: result.job || null,
      reason: result.reason || ""
    });
  });

  app.get("/api/training/metrics", (req, res) => {
    return res.json(trainingModule.getMetrics());
  });

  app.get("/api/training/jobs", (req, res) => {
    return res.json({
      jobs: trainingModule.getJobs(50)
    });
  });

  app.get("/training/dashboard", (req, res) => {
    return res.sendFile(path.join(__dirname, "public", "training-dashboard.html"));
  });

  app.post("/api/translate", async (req, res) => {
    const startedAt = Date.now();
    const requestApiKey = (req.get("x-openai-api-key") || "").trim();
    const { text, locale, targetLanguage, region } = req.body;

    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "Text is required." });
    }

    const localeConfig = loadLocaleConfig(locale);
    const destination = targetLanguage || "Vietnamese";

    try {
      const result = await translateHandler(text, requestApiKey, localeConfig.locale, destination);
      trainingModule.collectInteraction({
        sourceText: text.trim(),
        modelOutput: result.translatedText || "",
        targetLanguage: destination,
        locale: localeConfig.locale,
        sourceType: "translate_endpoint",
        latencyMs: Date.now() - startedAt,
        region
      });
      return res.json({
        originalText: text.trim(),
        translatedText: result.translatedText,
        formattedResult: result.fullResult,
        locale: result.localeConfig.locale,
        localeFallbackUsed: result.localeConfig.fallbackUsed,
        targetLanguage: destination
      });
    } catch (error) {
      const errorCode = resolveErrorCode(error);
      trainingModule.collectInteraction({
        sourceText: text.trim(),
        modelOutput: text.trim(),
        targetLanguage: destination,
        locale: localeConfig.locale,
        sourceType: "translate_endpoint_fallback",
        userAccepted: false,
        latencyMs: Date.now() - startedAt,
        region
      });
      logException("translation_failed", error, {
        endpoint: "/api/translate",
        localeRequested: locale || "",
        localeUsed: localeConfig.locale,
        localeFallbackUsed: localeConfig.fallbackUsed,
        errorCode
      });
      return res.json({
        originalText: text.trim(),
        translatedText: text.trim(),
        locale: localeConfig.locale,
        localeFallbackUsed: localeConfig.fallbackUsed,
        targetLanguage: destination,
        fallbackUsed: true,
        errorCode,
        warning: localeConfig.messages.translationUnavailable
      });
    }
  });

  app.get("/api/health", (req, res) => {
    return res.json({
      ok: true,
      environment: process.env.NODE_ENV || "development"
    });
  });

  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  return app;
}

if (require.main === module) {
  const app = createApp({
    enableTrainingScheduler: true
  });
  const server = app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
  server.on("close", () => {
    if (app.locals.trainingModule && app.locals.trainingModule.stop) {
      app.locals.trainingModule.stop();
    }
  });
}

module.exports = {
  createApp,
  extractTranslationOnly,
  translateNomHanToVietnamese,
  resolveErrorCode,
  isValidApiKeyFormat,
  normalizeChatMessages
};
