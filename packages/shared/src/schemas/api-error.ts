import { z } from 'zod';
import { ERROR_CODES } from '../errors.js';

/** Error body of all API errors. `fields` is present only for `validation_failed`. */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    fields: z.record(z.string(), z.string()).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
