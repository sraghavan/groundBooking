import { zValidator } from '@hono/zod-validator';
import type { ValidationTargets } from 'hono';
import type { ZodType } from 'zod';
import { HttpError } from './errors.js';

/** zod validation that throws a uniform 422 error. */
export const v = <T extends ZodType, Target extends keyof ValidationTargets>(target: Target, schema: T) =>
  zValidator(target, schema, (result) => {
    if (!result.success) {
      const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      throw new HttpError(422, issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; '), issues);
    }
  });
