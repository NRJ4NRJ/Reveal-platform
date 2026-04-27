import { Request, Response, NextFunction } from "express";

export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  console.error(err);
  const status = err.status || 500;
  const message = err.message || "Erreur interne du serveur";
  const code = err.code || "INTERNAL_ERROR";
  res.status(status).json({ error: message, code });
}
