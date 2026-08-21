export declare const MODERATION_NOTICE: string;

export declare function isContentModerationCode(code?: string, message?: string): boolean;

export declare function describeUpstreamError(
  code: string | undefined,
  message: string,
  status?: number,
  elapsedMs?: number,
): string;
