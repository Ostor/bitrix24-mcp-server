import { Router, Request, Response } from "express";
import crypto from "crypto";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const router = Router();

// Конфигурационные переменные
const BITRIX24_CLIENT_ID = process.env.BITRIX24_CLIENT_ID || "";
const BITRIX24_CLIENT_SECRET = process.env.BITRIX24_CLIENT_SECRET || "";
const B24_OAUTH_URL = "https://oauth.bitrix.info/oauth/authorize/";
const B24_TOKEN_URL = "https://oauth.bitrix.info/oauth/token/";

// Публичный URL нашего сервера
const SERVER_PUBLIC_URL = (process.env.SERVER_PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "");

// Ключ шифрования для обеспечения безопасности без хранения сессий в БД
const OAUTH_CRYPTO_SECRET = process.env.OAUTH_CRYPTO_SECRET || "default-secret-key-please-change-in-production";
const ENCRYPTION_KEY = crypto.scryptSync(OAUTH_CRYPTO_SECRET, "salt", 32);
const IV_LENGTH = 16;

function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

function decrypt(text: string): string {
  const textParts = text.split(":");
  const ivHex = textParts.shift();
  if (!ivHex) throw new Error("Invalid encrypted text format");
  const iv = Buffer.from(ivHex, "hex");
  const encryptedText = Buffer.from(textParts.join(":"), "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString("utf8");
}

function base64UrlEncode(str: Buffer): string {
  return str
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function verifyPkce(codeVerifier: string, codeChallenge: string, method: string = "S256"): boolean {
  if (method === "plain") {
    return codeVerifier === codeChallenge;
  }
  if (method === "S256") {
    const hash = crypto.createHash("sha256").update(codeVerifier).digest();
    const challenge = base64UrlEncode(hash);
    return challenge === codeChallenge;
  }
  return false;
}

// 1. Метаданные защищенного ресурса (Discovery RFC 9728)
router.get("/.well-known/oauth-protected-resource", (req: Request, res: Response) => {
  console.log("[OAuth] Discovery: /.well-known/oauth-protected-resource requested. Query:", req.query);
  console.log("[OAuth] Headers:", JSON.stringify(req.headers, null, 2));
  const requestedResource = (req.query.resource as string) || `${SERVER_PUBLIC_URL}/sse`;
  
  // Если запрашивается ресурс для Telegram MCP, возвращаем 404, так как он не требует OAuth
  if (requestedResource && requestedResource.includes("/telegram/")) {
    console.log("[OAuth] Resource is for telegram, returning 404 (no OAuth required)");
    return res.status(404).send("Resource does not require OAuth authorization");
  }
  res.json({
    resource: requestedResource,
    authorization_servers: [
      `${SERVER_PUBLIC_URL}`
    ]
  });
});

// 2. Метаданные авторизационного сервера (Discovery RFC 8414)
router.get("/.well-known/oauth-authorization-server", (req: Request, res: Response) => {
  console.log("[OAuth] Discovery: /.well-known/oauth-authorization-server requested");
  res.json({
    issuer: `${SERVER_PUBLIC_URL}`,
    authorization_endpoint: `${SERVER_PUBLIC_URL}/oauth/authorize`,
    token_endpoint: `${SERVER_PUBLIC_URL}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    code_challenge_methods_supported: ["S256", "plain"]
  });
});

// 3. Старт авторизации
router.get("/oauth/authorize", (req: Request, res: Response) => {
  console.log("[OAuth] /oauth/authorize called with query:", req.query);
  const {
    response_type,
    client_id,
    redirect_uri,
    state,
    code_challenge,
    code_challenge_method
  } = req.query;

  if (response_type !== "code") {
    console.warn("[OAuth] Rejected /oauth/authorize due to unsupported response_type:", response_type);
    return res.status(400).send("Unsupported response_type. Only 'code' is supported.");
  }

  const sessionData = {
    claudeClientId: client_id as string,
    claudeRedirectUri: redirect_uri as string,
    claudeState: state as string,
    codeChallenge: code_challenge as string,
    codeChallengeMethod: (code_challenge_method || "S256") as string,
    scope: (req.query.scope as string) || "crm,tasks_extended,task,tasks,user,im",
    createdAt: Date.now()
  };

  const encryptedState = encodeURIComponent(encrypt(JSON.stringify(sessionData)));
  const ourRedirectUri = `${SERVER_PUBLIC_URL}/oauth-callback`;
  const b24AuthUrl = `${B24_OAUTH_URL}?client_id=${BITRIX24_CLIENT_ID}&redirect_uri=${encodeURIComponent(ourRedirectUri)}&state=${encryptedState}`;

  console.log("[OAuth] Redirecting user to Bitrix24 authorize page:", b24AuthUrl);
  res.redirect(b24AuthUrl);
});

// 4. Коллбек Битрикс24
const callbackHandler = (req: Request, res: Response) => {
  console.log("[OAuth] /oauth/callback called with query:", req.query);
  const { code, state } = req.query;

  if (!code || !state) {
    console.error("[OAuth] Callback missing code or state");
    return res.status(400).send("Authorization code or state is missing from Bitrix24 response.");
  }

  try {
    const sessionData = JSON.parse(decrypt(state as string));
    console.log("[OAuth] Decrypted session data from state:", sessionData);
    
    if (Date.now() - sessionData.createdAt > 10 * 60 * 1000) {
      console.warn("[OAuth] Session expired");
      return res.status(400).send("Authorization session expired.");
    }

    const authCodeData = {
      b24Code: code as string,
      codeChallenge: sessionData.codeChallenge,
      codeChallengeMethod: sessionData.codeChallengeMethod,
      claudeRedirectUri: sessionData.claudeRedirectUri,
      scope: sessionData.scope,
      createdAt: Date.now()
    };

    const ourCode = encrypt(JSON.stringify(authCodeData));
    const claudeRedirect = `${sessionData.claudeRedirectUri}?code=${encodeURIComponent(ourCode)}&state=${encodeURIComponent(sessionData.claudeState)}`;
    
    console.log("[OAuth] Redirecting user back to Claude at:", claudeRedirect);
    res.redirect(claudeRedirect);
  } catch (error: any) {
    console.error("[OAuth] Callback decryption error:", error);
    res.status(500).send(`Failed to complete authorization: ${error.message}`);
  }
};

router.get("/oauth/callback", callbackHandler);
router.get("/oauth-callback", callbackHandler);

// 5. Обмен кода на токены
router.post("/oauth/token", async (req: Request, res: Response) => {
  console.log("[OAuth] /oauth/token called with body:", req.body);
  const {
    grant_type,
    code,
    redirect_uri,
    client_id,
    code_verifier,
    refresh_token
  } = req.body;

  try {
    if (grant_type === "authorization_code") {
      if (!code || !redirect_uri || !code_verifier) {
        console.warn("[OAuth] /oauth/token missing parameters");
        return res.status(400).json({ error: "invalid_request", error_description: "Missing required parameters" });
      }

      const authCodeData = JSON.parse(decrypt(code));
      console.log("[OAuth] Decrypted authorization code details:", authCodeData);

      if (Date.now() - authCodeData.createdAt > 5 * 60 * 1000) {
        console.warn("[OAuth] Authorization code expired");
        return res.status(400).json({ error: "invalid_grant", error_description: "Authorization code expired" });
      }

      if (authCodeData.codeChallenge) {
        const isValid = verifyPkce(code_verifier, authCodeData.codeChallenge, authCodeData.codeChallengeMethod);
        if (!isValid) {
          console.warn("[OAuth] PKCE verification failed");
          return res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
        }
        console.log("[OAuth] PKCE verification passed");
      }

      const ourRedirectUri = `${SERVER_PUBLIC_URL}/oauth-callback`;
      console.log("[OAuth] Exchanging code with Bitrix24 token endpoint. Params:", {
        grant_type: "authorization_code",
        client_id: BITRIX24_CLIENT_ID,
        code: authCodeData.b24Code,
        redirect_uri: ourRedirectUri
      });

      const response = await axios.get(B24_TOKEN_URL, {
        params: {
          grant_type: "authorization_code",
          client_id: BITRIX24_CLIENT_ID,
          client_secret: BITRIX24_CLIENT_SECRET,
          code: authCodeData.b24Code,
          redirect_uri: ourRedirectUri
        }
      });

      console.log("[OAuth] Successful token exchange from Bitrix24:", response.data);
      
      // Добавляем обязательный token_type и запрашиваемый scope для совместимости с RFC 6749
      const oauthResponse = {
        ...response.data,
        token_type: "Bearer",
        scope: authCodeData.scope || "crm,tasks_extended,task,tasks,user,im"
      };
      
      res.json(oauthResponse);
    } else if (grant_type === "refresh_token") {
      if (!refresh_token) {
        console.warn("[OAuth] /oauth/token missing refresh_token");
        return res.status(400).json({ error: "invalid_request", error_description: "Missing refresh_token" });
      }

      console.log("[OAuth] Refreshing token with Bitrix24...");
      const response = await axios.get(B24_TOKEN_URL, {
        params: {
          grant_type: "refresh_token",
          client_id: BITRIX24_CLIENT_ID,
          client_secret: BITRIX24_CLIENT_SECRET,
          refresh_token: refresh_token
        }
      });

      console.log("[OAuth] Token successfully refreshed:", response.data);
      
      // Добавляем обязательный token_type и scope для совместимости с RFC 6749
      const oauthResponse = {
        ...response.data,
        token_type: "Bearer",
        scope: response.data.scope || "crm,tasks_extended,task,tasks,user,im"
      };
      
      res.json(oauthResponse);
    } else {
      console.warn("[OAuth] Unsupported grant_type:", grant_type);
      res.status(400).json({ error: "unsupported_grant_type", error_description: "Grant type not supported" });
    }
  } catch (error: any) {
    console.error("[OAuth] Token exchange error:", error?.response?.data || error.message);
    const details = error?.response?.data || {};
    res.status(error?.response?.status || 500).json({
      error: details.error || "server_error",
      error_description: details.error_description || error.message
    });
  }
});

export default router;
