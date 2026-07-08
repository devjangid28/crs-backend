module.exports = {
  apps: [
    {
      name: "crs-backend",
      script: "src/server.js",
      cwd: "./crs-backend",
    },
    {
      name: "crs-tunnel",
      script: "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
      args: "tunnel run crs-tunnel",
    },
  ],
};
