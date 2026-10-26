// Vercel function: POST /api/embed-sign. See server/embed-relayer.ts.
// Explicit .js: Vercel runs the compiled ESM with Node, which needs extensions on relative imports.
import { handleEmbedSign } from '../server/embed-relayer.js';

export function POST(request: Request): Promise<Response> {
  return handleEmbedSign(request, process.env);
}
