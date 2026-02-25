/**
 * logger.js — Winston structured logger
 *
 * Outputs JSON logs in production (machine-parseable for log aggregators)
 * and colourised, readable logs in development.
 *
 * Log files are written to /logs/ beside the project root:
 *   • combined.log   — every log level
 *   • error.log      — errors only
 * Files rotate daily and are kept for 14 days.
 */

import winston from "winston";
import "winston-daily-rotate-file";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_DIR = path.join(__dirname, "../../../logs");

const { combine, timestamp, errors, json, colorize, printf } = winston.format;

// Human-readable format for dev
const devFormat = combine(
  colorize({ all: true }),
  timestamp({ format: "HH:mm:ss" }),
  errors({ stack: true }),
  printf(({ level, message, timestamp, stack, ...meta }) => {
    const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
    return `${timestamp} [${level}] ${stack || message}${extra}`;
  }),
);

// JSON format for production / log aggregators
const prodFormat = combine(timestamp(), errors({ stack: true }), json());

const isProduction = process.env.NODE_ENV === "production";

const transports = [
  // Always write to console
  new winston.transports.Console({
    format: isProduction ? prodFormat : devFormat,
  }),
];

if (isProduction) {
  // Rotating file transport — production only
  transports.push(
    new winston.transports.DailyRotateFile({
      filename: path.join(LOG_DIR, "error-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      level: "error",
      maxFiles: "14d",
      zippedArchive: true,
    }),
    new winston.transports.DailyRotateFile({
      filename: path.join(LOG_DIR, "combined-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      maxFiles: "14d",
      zippedArchive: true,
    }),
  );
}

const logger = winston.createLogger({
  level: isProduction ? "info" : "debug",
  transports,
  // Don't crash the process on unhandled logger errors
  exitOnError: false,
});

export default logger;
