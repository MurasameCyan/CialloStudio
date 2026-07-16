import type { IncomingMessage } from "node:http";

export type UpstreamResult =
  | { ok: true; origin: string }
  | { ok: false; code: string; message: string };

export type ValidateOptions = {
  allowlist?: string[];
};

export function isHardBlockedIp(ip: string): boolean;
export function isBlockedIp(ip: string): boolean;

export function parseUpstreamAllowlist(raw?: string): string[];

export function isOriginAllowlisted(
  origin: string,
  hostname: string,
  allowlist: string[],
): boolean;

export function parseUpstreamCandidate(
  raw: string,
):
  | { ok: true; origin: string; hostname: string }
  | { ok: false; code: string; message: string };

export function validateUpstreamOrigin(
  raw: string,
  options?: ValidateOptions,
): Promise<UpstreamResult>;

export function debugValidateUpstream(
  raw: string,
  options?: ValidateOptions,
): Promise<{
  input: string | null;
  parsed:
    | { origin: string; hostname: string }
    | { error: { ok: false; code: string; message: string } };
  allowlist: string[];
  allowlisted: boolean;
  result: UpstreamResult;
}>;

export function readUpstreamRawFromRequest(req: IncomingMessage): string;
