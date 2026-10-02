import type { Request } from "express";

/** The visitor's IP: Traefik's X-Real-IP, else the socket peer. */
export const clientIp = (req: Request) => String(req.headers["x-real-ip"] ?? req.socket.remoteAddress ?? "");

/** One cookie's value from the request, URL-decoded. */
export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}
