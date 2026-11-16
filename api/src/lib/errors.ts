export class HttpError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 422, message: string, public details?: unknown) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`);
