export type JwtPayload = {
  userId: number;
  username: string;
};

import type { Request } from "express";

export type AuthenticatedRequest = Request & {
  user?: JwtPayload;
};
