module.exports = {
  apps: [
    {
      name: 'enfyra-server',
      script: 'dist/src/main.js',
      instances: '4',
      exec_mode: 'cluster',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 4000,
    },
  ],
};
