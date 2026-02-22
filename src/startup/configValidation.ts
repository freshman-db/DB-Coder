import type { DbCoderConfig } from '../config/types.js';
import { log } from '../utils/logger.js';
import { ConfigValidationError, validateConfig } from '../utils/validateConfig.js';

export function validateConfigForStartup(config: DbCoderConfig, projectPath: string): boolean {
  try {
    validateConfig(config, projectPath);
    return true;
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      log.error(err.message);
      return false;
    }
    throw err;
  }
}
