#!/usr/bin/env node
/**
* Helper application to bundle up the command line into an Electron application
* This program really just relaunches the electron shell encoding the process.argv structure into the process.env.CONKER_ARGS as a JSON array
*/

var childProcess = require('child_process');
var electron = require('electron-prebuilt');

childProcess.spawn(electron, [
	'--enable-transparent-visuals',
	'--disable-gpu',
	__dirname + '/app.js',
], {
	stdio: 'inherit',
	env: function() { // Inherit this envrionment but glue CONKER_ARGS to the object
		var env = process.env;
		env.CONKER_ARGS = JSON.stringify(process.argv);
		return env;
	}(),
});