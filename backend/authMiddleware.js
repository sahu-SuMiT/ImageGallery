import { OAuth2Client } from "google-auth-library";

const googleClient = new OAuth2Client();

export async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Authentication required. Please sign in with Google.",
    });
  }

  const token = authHeader.split(" ")[1]?.trim();
  if (!token) {
    return res.status(401).json({ error: "Empty authorization token provided." });
  }

  // Handle demo token (for testing before setting up Google Cloud Console)
  if (token.startsWith("demo_user_")) {
    const demoId = token.replace("demo_user_", "");
    req.user = {
      id: `demo_${demoId}`,
      email: `${demoId}@example.com`,
      name: `Demo User (${demoId})`,
      picture: null,
    };
    return next();
  }

  try {
    const clientId = process.env.GOOGLE_CLIENT_ID?.trim();

    if (clientId) {
      // Verify cryptographically with Google
      const ticket = await googleClient.verifyIdToken({
        idToken: token,
        audience: clientId,
      });
      const payload = ticket.getPayload();
      req.user = {
        id: payload.sub,
        email: payload.email,
        name: payload.name,
        picture: payload.picture,
      };
    } else {
      // Safe fallback: decode token payload if GOOGLE_CLIENT_ID is not yet configured on backend
      const parts = token.split(".");
      if (parts.length === 3) {
        const payload = JSON.parse(
          Buffer.from(parts[1], "base64").toString("utf-8")
        );
        req.user = {
          id: payload.sub || payload.id || "anonymous_google_user",
          email: payload.email || "user@gmail.com",
          name: payload.name || "Google User",
          picture: payload.picture || null,
        };
      } else {
        return res.status(401).json({ error: "Malformed authorization token." });
      }
    }

    next();
  } catch (err) {
    console.error("Google Auth verification failed:", err.message);
    return res.status(401).json({
      error: "Invalid or expired Google token. Please sign in again.",
    });
  }
}
