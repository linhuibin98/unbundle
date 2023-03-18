#!/usr/bin/env node
const { createServer } = require('../dist/server')
const argv = require('minimist')(process.argv.slice(2))

if (argv._.length) {
    argv.cwd = require('path').resolve(process.cwd(), argv._[0])
}

// TODO pass cli args
createServer(argv).catch(err => {
    console.error(err);
    process.exit(1);
})
