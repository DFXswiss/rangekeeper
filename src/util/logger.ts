import pino from 'pino';

let loggerInstance: pino.Logger | undefined;

export function createLogger(level?: string): pino.Logger {
  if (loggerInstance) return loggerInstance;

  loggerInstance = pino({
    level: level ?? process.env.LOG_LEVEL ?? 'info',
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
        : undefined,
    base: { service: 'rangekeeper' },
  });

  return loggerInstance;
}

export function getLogger(): pino.Logger {
  return loggerInstance ?? createLogger();
}
