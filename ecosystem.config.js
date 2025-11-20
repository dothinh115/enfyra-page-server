module.exports = {
  apps: [
    {
      name: 'demo-server',
      script: 'dist/src/main.js',
      exec_mode: 'fork',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 4000,
    },
  ],
};
