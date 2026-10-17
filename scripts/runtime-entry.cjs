// Every service belongs to the supervisor even when its console is hidden.
process.on('disconnect', () => process.exit(0));
process.on('message', message => { if (message === 'shutdown') process.exit(0); });
require(require('node:path').resolve(process.argv[2]));
