/**
 * PM2 Ecosystem Config
 *
 * Usage:
 *   npm install -g pm2
 *   pm2 start ecosystem.config.cjs          # start
 *   pm2 save                                 # persist across reboots
 *   pm2 startup                              # enable auto-start on boot
 *   pm2 logs fonlok-backend                  # tail logs
 *   pm2 monit                                # live dashboard
 *   pm2 restart fonlok-backend               # rolling restart
 *   pm2 stop fonlok-backend                  # graceful stop
 */

module.exports = {
  apps: [
    {
      name: "fonlok-backend",
      script: "./src/controllers/server.js",

      // ── Startup & restart ────────────────────────────────────────────────
      // Restart automatically after any crash, with exponential back-off
      // so a boot-loop doesn't spin the CPU.
      autorestart: true,
      max_restarts: 10,
      min_uptime: "5s", // if it crashes within 5 s, count as a failed start
      restart_delay: 1000, // ms between restarts

      // ── Clustering ───────────────────────────────────────────────────────
      // "max" forks one worker per CPU core; great for I/O-heavy Node apps.
      // Switch to instances: 1 if you ever add in-memory state that must be
      // shared (e.g. WebSocket rooms without Redis adapter).
      instances: "max",
      exec_mode: "cluster",

      // ── Environment ──────────────────────────────────────────────────────
      env: {
        NODE_ENV: "development",
        PORT: 5000,
      },
      env_production: {
        NODE_ENV: "production",
        PORT: 5000,
      },

      // ── Logging ──────────────────────────────────────────────────────────
      // Winston already writes to /logs/; these PM2 logs capture
      // anything written directly to stdout/stderr before Winston initialises.
      out_file: "./logs/pm2-out.log",
      error_file: "./logs/pm2-error.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",

      // ── Memory guard ─────────────────────────────────────────────────────
      // Restart the worker if it leaks past 512 MB. Adjust for your VPS.
      max_memory_restart: "512M",

      // ── Graceful shutdown ─────────────────────────────────────────────────
      // Give in-flight requests 10 s to complete before SIGKILL.
      kill_timeout: 10000,
      listen_timeout: 5000,
    },
  ],
};
