// "Sign in with Google" (identity only), behind FEATURE_GOOGLE_SIGNIN. A stub in v0.1:
// no OAuth client, no tokens, nothing stored. When it's built, it should:
//   - use the OpenID Connect scopes `openid email profile` and nothing else (no Drive, no Classroom),
//   - map the Google account to a session identity server-side, never send the email to the model,
//   - live entirely in this file plus a route guard, so tutor logic doesn't change.

import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.ts';

export function registerGoogleAuth(app: FastifyInstance, config: Config): void {
  if (!config.googleSignIn) return;
  app.get('/api/auth/google', async (_req, reply) =>
    reply.code(501).send({ error: 'Sign in with Google is not implemented in v0.1' }),
  );
}
