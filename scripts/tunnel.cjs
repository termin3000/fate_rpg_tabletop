const localtunnel = require('localtunnel');

let tunnel;
function stop() {
  tunnel?.close();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
if (process.send) process.on('disconnect', stop);

localtunnel({
  port: 3008,
  local_host: '127.0.0.1',
  ...(process.env.LOCALTUNNEL_HOST ? { host: process.env.LOCALTUNNEL_HOST } : {}),
  ...(process.env.LOCALTUNNEL_SUBDOMAIN ? { subdomain: process.env.LOCALTUNNEL_SUBDOMAIN } : {}),
}).then(opened => {
  tunnel = opened;
  tunnel.on('error', error => { console.error(error.message); process.exit(1); });
  tunnel.on('close', () => process.exit(0));
  console.log(JSON.stringify({ url: tunnel.url }));
}).catch(error => { console.error(error.message); process.exit(1); });
