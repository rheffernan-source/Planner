// Server-side enrichment for Professional Record entries.
//
// The API key lives here and only here — it is read from the ANTHROPIC_API_KEY
// environment variable set in the Netlify dashboard, and never reaches the
// browser. The client sends its Firebase ID token; this function verifies that
// token before spending anything, so someone who finds the URL can't run up a
// bill on the account.
//
// Nothing is logged. The entry text is sent to the Anthropic API to be
// processed and is not written to disk or to any third party here.

import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { APST, PRINCIPAL_PRACTICES } from "../../src/data/standards.js";

// Public identifier, not a secret — it already ships in the browser bundle.
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "planner2-9958c";

const GOOGLE_CERT_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

// --- Firebase token verification (no extra dependencies) -------------------
// Firebase ID tokens are RS256 JWTs signed by Google. Verifying one means
// checking the signature against Google's published certificates and then
// checking the claims. Node's built-in crypto does the signature part, so this
// needs no auth library.

let certCache = { certs: null, expiresAt: 0 };

async function googleCerts() {
  const now = Date.now();
  if (certCache.certs && now < certCache.expiresAt) return certCache.certs;

  const res = await fetch(GOOGLE_CERT_URL);
  if (!res.ok) throw new Error("Could not fetch Google signing certificates");
  const certs = await res.json();

  // Google tells us how long these are good for; respect it rather than
  // re-fetching on every call.
  const maxAge = /max-age=(\d+)/.exec(res.headers.get("cache-control") || "");
  const ttlMs = maxAge ? Number(maxAge[1]) * 1000 : 60 * 60 * 1000;
  certCache = { certs, expiresAt: now + ttlMs };
  return certs;
}

function decodeSegment(segment) {
  return Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

async function verifyFirebaseToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed token");
  const [rawHeader, rawPayload, rawSignature] = parts;

  const header = JSON.parse(decodeSegment(rawHeader).toString("utf8"));
  const payload = JSON.parse(decodeSegment(rawPayload).toString("utf8"));

  if (header.alg !== "RS256") throw new Error("Unexpected token algorithm");

  const certs = await googleCerts();
  const cert = certs[header.kid];
  if (!cert) throw new Error("Unknown token signing key");

  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(`${rawHeader}.${rawPayload}`);
  if (!verifier.verify(cert, decodeSegment(rawSignature))) {
    throw new Error("Bad token signature");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (payload.aud !== FIREBASE_PROJECT_ID) throw new Error("Token audience mismatch");
  if (payload.iss !== `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`) {
    throw new Error("Token issuer mismatch");
  }
  if (!payload.sub) throw new Error("Token has no subject");
  if (payload.exp <= nowSeconds) throw new Error("Token expired");
  if (payload.iat > nowSeconds + 300) throw new Error("Token issued in the future");

  return payload;
}

// --- Reference data --------------------------------------------------------
// Built once at module load from the same standards.js the app uses, so the
// codes the model may choose can never drift from the codes the UI renders.

const ALL_CODES = APST.flatMap((std) => std.focusAreas.map((fa) => fa.code));
const PRACTICE_TITLES = PRINCIPAL_PRACTICES.map((p) => p.title);
const NO_PRACTICE = "none";

const STANDARDS_REFERENCE = APST.map(
  (std) =>
    `Standard ${std.standard} — ${std.title} (${std.domain})\n` +
    std.focusAreas
      .map((fa) => `  ${fa.code} ${fa.title}: ${fa.descriptor}`)
      .join("\n")
).join("\n\n");

const PRACTICES_REFERENCE = PRINCIPAL_PRACTICES.map(
  (p) => `${p.title}: ${p.description}`
).join("\n\n");

const SYSTEM_PROMPT = `You help a NSW primary school teacher maintain their professional record. They log two kinds of entry: professional development (PD), and leadership moments. Your job is to turn what they typed into structured record text.

These entries are evidence. They may be used for NESA accreditation, for job applications, or produced in an audit years from now. That makes accuracy more important than polish.

Work only from what the teacher wrote:
- Do not add facts, outcomes, dates, numbers, or names that are not in their text. If something is not stated, leave it unstated.
- Do not inflate their role. If they helped, say helped — do not upgrade it to led.
- Do not claim an outcome that has not happened. Leadership moments are usually logged the same day, before anyone knows how it turned out. Saying the result is not yet known is the correct answer in that case, not a failure.

Writing:
- Keep it in first person. This is their own record of their own work.
- Australian English spelling.
- Professionalising means clearer wording and a more formal register. It does not mean longer, and it does not mean more impressive. Aim for something shorter than what they wrote.
- Keep the concrete specifics — what happened, who was involved, what they actually did. Cut filler, hedging, and repetition.

Choosing standards:
- Only assign a focus area when the entry genuinely evidences it. An empty list is a correct and common answer, especially for short entries.
- Two or three well-matched codes are worth more than a long speculative list.
- Same for the principal practice: return "${NO_PRACTICE}" unless the entry clearly demonstrates one.

Australian Professional Standards for Teachers — the focus areas you may choose from:

${STANDARDS_REFERENCE}

Australian Professional Standard for Principals — the five practices you may choose from:

${PRACTICES_REFERENCE}`;

// --- Response schemas ------------------------------------------------------
// Putting the valid codes in the schema as an enum means the model physically
// cannot return a focus area that doesn't exist.

function schemaFor(type) {
  const shared = {
    summary: {
      type: "string",
      description:
        "The entry rewritten as clear, professional first-person prose. Shorter than the original.",
    },
    suggestedTitle: {
      type: "string",
      description: "A short factual title for this entry, under 80 characters.",
    },
    suggestedStandards: {
      type: "array",
      items: { type: "string", enum: ALL_CODES },
      description:
        "APST focus area codes this entry genuinely evidences. Empty array if none clearly apply.",
    },
    suggestedPractice: {
      type: "string",
      enum: [...PRACTICE_TITLES, NO_PRACTICE],
      description: `The principal practice demonstrated, or "${NO_PRACTICE}".`,
    },
  };

  if (type === "pd") {
    return {
      type: "object",
      properties: shared,
      required: Object.keys(shared),
      additionalProperties: false,
    };
  }

  const properties = {
    ...shared,
    star: {
      type: "object",
      properties: {
        situation: { type: "string", description: "The context and what was at stake." },
        task: { type: "string", description: "What needed to be done, and their responsibility in it." },
        action: { type: "string", description: "What they actually did." },
        result: {
          type: "string",
          description:
            "What changed as a result. If the entry does not say, state plainly that the outcome is not yet recorded — never invent one.",
        },
      },
      required: ["situation", "task", "action", "result"],
      additionalProperties: false,
    },
    resultKnown: {
      type: "boolean",
      description:
        "True only if the teacher's text actually states an outcome. False if the result is still unknown.",
    },
  };

  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

// --- Handler ---------------------------------------------------------------

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  // --- who is asking ---
  // Deliberately before the API-key check: an unauthenticated caller learns
  // nothing about how this server is configured.
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return json({ error: "Not signed in." }, 401);

  try {
    await verifyFirebaseToken(token);
  } catch {
    // Deliberately generic — internal parser/crypto detail isn't the caller's
    // business, and in practice this almost always means a stale token.
    return json({ error: "Sign-in could not be verified. Try reloading the page." }, 401);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return json(
      { error: "The server is missing its ANTHROPIC_API_KEY setting." },
      500
    );
  }

  // --- what they sent ---
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Expected a JSON body." }, 400);
  }

  const type = body?.type;
  const rawInput = typeof body?.rawInput === "string" ? body.rawInput.trim() : "";

  if (type !== "pd" && type !== "leadership") {
    return json({ error: 'type must be "pd" or "leadership".' }, 400);
  }
  if (!rawInput) return json({ error: "rawInput is empty." }, 400);
  if (rawInput.length > 20000) {
    return json({ error: "That entry is too long to process." }, 413);
  }

  // --- ask Claude ---
  const client = new Anthropic();

  try {
    const response = await client.beta.messages.create({
      model: "claude-opus-5",
      // Thinking is on by default and shares this budget with the response,
      // so leave real headroom — a tight cap truncates the JSON mid-object.
      max_tokens: 8000,
      // If a safety classifier declines an entry (a bluntly described
      // behaviour incident could), fall back rather than failing outright.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          // The 37 descriptors are identical on every call. Caching them makes
          // a run of entries in one sitting noticeably cheaper.
          cache_control: { type: "ephemeral" },
        },
      ],
      output_config: {
        format: { type: "json_schema", schema: schemaFor(type) },
      },
      messages: [
        {
          role: "user",
          content: `Entry type: ${type === "pd" ? "professional development" : "leadership moment"}\n\nWhat the teacher wrote:\n\n${rawInput}`,
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      return json(
        {
          error:
            "This entry couldn't be processed automatically. Your text is saved and unchanged — you can fill the details in by hand.",
        },
        422
      );
    }

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock) return json({ error: "No usable response from the model." }, 502);

    let parsed;
    try {
      parsed = JSON.parse(textBlock.text);
    } catch {
      return json({ error: "The model's response was not valid JSON." }, 502);
    }

    return json({
      enrichment: {
        version: 1,
        at: Date.now(),
        model: response.model,
        summary: parsed.summary ?? null,
        suggestedTitle: parsed.suggestedTitle ?? null,
        suggestedStandards: parsed.suggestedStandards ?? [],
        suggestedPractice:
          parsed.suggestedPractice && parsed.suggestedPractice !== NO_PRACTICE
            ? parsed.suggestedPractice
            : null,
        star: parsed.star ?? null,
        resultKnown: parsed.resultKnown ?? null,
      },
    });
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      return json({ error: "Rate limited — try again in a moment." }, 429);
    }
    if (error instanceof Anthropic.AuthenticationError) {
      return json({ error: "The server's API key was rejected." }, 500);
    }
    if (error instanceof Anthropic.APIError) {
      return json({ error: `The AI service returned an error (${error.status}).` }, 502);
    }
    return json({ error: "Enrichment failed." }, 500);
  }
};
