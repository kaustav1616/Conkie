var _ = require('lodash');
var async = require('async-chainable');
var asyncExec = require('async-chainable-exec');
var boxSizing = require('box-sizing');
var colors = require('colors');
var conkieStats = require('conkie-stats');
var ejs = require('ejs');
var electron = require('electron');
var fs = require('fs');
var fspath = require('path');
var moduleFinder = require('module-finder');
var os = require('os');
var temp = require('temp').track();
var util = require('util');

// Global objects {{{
var app;
var win;
var onBattery; // Whether we are running in low-refresh mode
var tempFile; // File compiled at boot containing main HTML body
// }}}

// Global processes {{{
// Exposed functions designed to work as async callbacks

/**
* Load the theme
* @param function finish The callback to invoke when done
* This process breaks down as follows:
* 1. Read in the main HTML file for the theme
* 2. Figure out all the linked JS / CSS assets
* 3. Read the contents of all assets discovered
* 4. Insert contents inline into HTML stream
* 5. Write a file with all the above
*/
function loadTheme(finish) {
	async()
		.set('themeMain', '') // Path to main HTML file (either path or module+path)
		.set('themeDir', '') // Path to main directory of theme
		.parallel({
			themeStats: function(next) {
				fs.stat(program.theme, function(err, stat) {
					next(null, stat); // Ignore file not found errors
				});
			},
			themeModule: function(next) {
				moduleFinder({
					local: true,
					global: true,
					cwd: __dirname,
					filter: {
						name: program.theme,
					},
				}).then(function(res) {
					if (res.length) { // Found a matching module
						return next(null, res[0]);
					} else { // No module matching this found
						return next();
					}
				}, next);
			},
		})
		.then(function(next) {
			// Figure out themeMain + themeDir {{{
			if (this.themeStats && this.themeStats.isFile()) { // Process as path
				this.themeMain = program.theme;
				this.themeDir = fspath.dirname(this.themeMain);
				if (program.verbose > 1) console.log(colors.blue('[Conkie]'), 'Using theme path', colors.cyan(this.themeMain));
				next();
			} else if (this.themeModule) {
				this.themeMain = fspath.join(fspath.dirname(this.themeModule.path), this.themeModule.pkg.main);
				this.themeDir = fspath.dirname(this.themeMain);
				if (program.verbose > 1) console.log(colors.blue('[Conkie]'), 'Using theme module', colors.cyan(this.themeModule.pkg.name), 'with HTML path', colors.cyan(this.themeMain));
				next();
			} else {
				next('No theme file or matching module found');
			}
			// }}}
		})
		.then('content', function(next) {
			// Read in theme file {{{
			fs.readFile(this.themeMain, 'utf8', next);
			// }}}
		})
		.then('content', function(next) {
			// Recompile main HTML file {{{
			async()
				.set('themeDir', this.themeDir)
				.set('content', this.content)
				.set('findModules', [])
				.set('moduleBlacklist', [ // Never try to replace these module requires
					'electron', // Electron object is provided by parent process
					'lodash', // Already included in main project
				])
				.set('markers', [])
				.parallel([
					// Extract all required CSS modules {{{
					function(next) {
						var self = this;
						this.content = this.content.replace(/<link.+?href="<%=paths.modules%>\/(.+?)\/(.+?)".*?>/g, function(block, module, cssFile) {
							var marker = '<!-- CSS FOR [' + module + '/' + cssFile + '] -->';
							self.markers.push({type: 'css', module: module, file: cssFile, marker: marker});
							self.findModules.push(module);
							return marker;
						});
						next();
					},
					// }}}
					// Extract all required JS modules {{{
					function(next) {
						var self = this;
						this.content = this.content.replace(/<script.+?src="<%=paths.modules%>\/(.+?)\/(.+?)".*>\s*<\/script>/, function(block, module, jsFile) {
							var marker = '<!-- JS FOR [' + module + '/' + jsFile + '] -->';
							self.markers.push({type: 'js', module: module, file: jsFile, marker: marker});
							self.findModules.push(module);
							return marker;
						});
						next();
					},
					// }}}
					// Extract all local JS modules {{{
					function(next) {
						var self = this;
						this.content = this.content.replace(/<script.+?src="<%=paths.theme%>\/(.+?)".*?>\s*<\/script>/, function(block, jsFile) {
							var marker = '<!-- JS LOCAL FOR [' + jsFile + '] -->';
							self.markers.push({type: 'jsLocal', file: fspath.join(self.themeDir, jsFile), marker: marker});
							return marker;
						});
						next();
					},
					// }}}
				])

				// Cache all local JS files contents so we know what modules we will need in the compile stage {{{
				.then(function(next) {
					var self = this;
					async()
						.forEach(_.filter(this.markers, {type: 'jsLocal'}), function(next, m) {
							fs.readFile(m.file, 'utf8', function(err, content) {
								if (err) return next('Error loading JS file "' + m.file + '" required as JS local pre-load');

								m.content = content;

								// Scan for required modules in this file {{{
								var requireModRe = /require\(("|')(.+?)\1\)/g;
								var match;
								while (match = requireModRe.exec(content)) {
									self.findModules.push(match[2]);
								}
								// }}}

								next();
							});
						})
						.end(next);
				})
				// }}}

				// Find all required NPM modules in findModules {{{
				.then('modules', function(next) {
					var self = this;

					this.findModules = _(this.findModules)
						.uniq()
						.filter(function(m) { return !_.includes(self.moduleBlacklist, m) }) // Remove blacklisted modules
						.value();

					if (program.verbose > 2) console.log(colors.blue('[Theme/Preparser]'), 'Find modules', colors.cyan(this.findModules.map(function(m) { return colors.cyan(m) }).join(', ')));
					moduleFinder({
						local: true,
						global: true,
						cwd: this.themeDir,
						filter: {
							name: {'$in': this.findModules}
						},
					}).then(function(res) { next(null, res) }, next);
				})
				// }}}

				// Replace markers with content know we know the real module location {{{
				.parallel([
					// Replace all required CSS modules {{{
					function(next) {
						var self = this;
						async()
							.forEach(_.filter(this.markers, {type: 'css'}), function(next, m) {
								var npm = self.modules.find(function(mod) { return mod.pkg.name == m.module });
								if (!npm) return next('Cannot find NPM module "' + m.module + '" required by CSS pre-load of "' + m.file + '"');

								var cssPath = fspath.join(fspath.dirname(npm.path), m.file);

								if (program.verbose > 2) console.log(colors.blue('[Theme/Preparser]'), 'Read CSS asset', colors.cyan(cssPath));
								fs.readFile(cssPath, 'utf8', function(err, content) {
									if (err) return finish(err);
									self.content = self.content.replace(m.marker, m.marker + '\n' + '<style>' + content + '</style>');
									next();
								});
							})
							.end(next);
					},
					// }}}
					// Replace all required JS modules {{{
					function(next) {
						var self = this;
						async()
							.forEach(_.filter(this.markers, {type: 'js'}), function(next, m) {
								var npm = self.modules.find(function(mod) { return mod.pkg.name == m.module });
								if (!npm) return next('Cannot find NPM module "' + m.module + '" required by JS pre-load of "' + m.file + '"');

								var jsPath = fspath.join(fspath.dirname(npm.path), m.file);

								if (program.verbose > 2) console.log(colors.blue('[Theme/Preparser]'), 'Read JS asset', colors.cyan(jsPath));
								fs.readFile(jsPath, 'utf8', function(err, content) {
									if (err) return finish(err);
									self.content = self.content.replace(m.marker, m.marker + '\n' + '<script>' + content + '</script>');
									next();
								});
							})
							.end(next);
					},
					// }}}
					// Replace all required JS local modules {{{
					function(next) {
						var self = this;
						async()
							.forEach(_.filter(this.markers, {type: 'jsLocal'}), function(next, m) {
								if (program.verbose > 2) console.log(colors.blue('[Theme/Preparser]'), 'Rewrite JS local asset', colors.cyan(m.file));

								// Replace required modules in this file {{{
								m.content = m.content.replace(/require\(("|')(.+?)\1\)/g, function(block, enclose, module) {
									if (_.includes(self.moduleBlacklist, module)) return block; // Skip blacklisted modules

									var npm = self.modules.find(function(mod) { return mod.pkg.name == module });
									if (!npm) return next('Cannot find NPM module "' + module + '" required by JS local pre-load of "' + m.file + '"');

									return 'require(' + enclose + fspath.dirname(npm.path) + enclose + ')';
								});
								// }}}

								self.content = self.content.replace(m.marker, m.marker + '\n' + '<script>' + m.content + '</script>');
								next();
							})
							.end(next);
					},
					// }}}
				])
				// }}}

				// End {{{
				.end(function(err) {
					next(err, this.content);
				});
				// }}}
			// }}}
		})
		.then(function(next) {
			// Create temp file (which is the EJS compiled template) {{{
			var self = this;
			if (tempFile) return next(); // tempFile already setup
			tempFile = temp.path({suffix: '.html'});
			if (program.verbose > 1) console.log(colors.blue('[Conkie]'), 'Setup temp file', colors.cyan(tempFile));
			fs.writeFile(tempFile, ejs.render(this.content, {
				debugMode: program.debug,
				paths: {
					root: 'file://' + __dirname,
					theme: 'file://' + self.themeDir,
				},
			}), function(err) {
				if (err) return next(err);
				next(null, tempFile);
			});
			// }}}
		})
		.end(finish);
}
// }}}

// Process command line args {{{
var program = require('commander');

program
	.version(require('./package.json').version)
	.option('-d, --debug', 'Enter debug mode. Show as window and enable dev-tools')
	.option('-v, --verbose', 'Be verbose. Specify multiple times for increasing verbosity', function(i, v) { return v + 1 }, 0)
	.option('-t, --theme [file]', 'Specify main theme HTML file (default = "conkie-theme-default")', 'conkie-theme-default')
	.option('-b, --background', 'Detach from parent (prevents quitting when parent process dies)')
	.option('--refresh [ms]', 'Time in MS to refresh all system statistics (when on power, default = 1s)', 1000)
	.option('--refresh-battery [ms]', 'Time in MS to refresh system stats (when on battery, default = 10s)', 10000)
	.option('--debug-stats', 'Show stats object being transmitted to front-end')
	.option('--watch', 'Watch the theme directory and reload on any changes')
	.option('--no-color', 'Disable colors')
	.parse(process.env.CONKIE_ARGS ? JSON.parse(process.env.CONKIE_ARGS) : '')
// }}}

// Storage for dynamically updated values {{{
var cpuUsage;
var ifSpeeds = {};
// }}}

async()
	.then(function(next) {
		// Setup browser app {{{
		app = electron.app
			.once('window-all-closed', function() {
				if (program.verbose > 2) console.log(colors.blue('[Conkie]'), 'All windows closed');
				if (process.platform != 'darwin') app.quit(); // Kill everything if we're on Darwin
			})
			.once('ready', function() {
				if (program.verbose > 2) console.log(colors.blue('[Conkie]'), 'Electron app ready');
				next();
			})
			.once('error', next);
		// }}}
	})
	.then(loadTheme)
	.then(function(next) {
		// Setup page {{{
		// Create the browser window.
		win = new electron.BrowserWindow(
			program.debug
				? {
					width: 1000,
					height: 1000,
					frame: true,
					title: 'Conkie',
					show: false,
				}
				: {
					width: 200,
					height: 1000,
					frame: false,
					resizable: false,
					skipTaskbar: true,
					title: 'Conkie',
					type: 'desktop',
					show: false,
					transparent: true,
					x: 10,
					y: 10,
					center: false,
				}
		);

		win.on('page-title-updated', function(e) {
			// Prevent title changes so we can always find the window
			e.preventDefault();
		})

		win.loadURL('file://' + tempFile);

		win.webContents.once('dom-ready', function() {
			if (program.debug) {
				win.show();
				win.webContents.openDevTools();
			} else {
				win.showInactive();
			}

			return next();
		});
		// }}}
	})
	.parallel([
		// Listen for messages {{{
		function(next) {
			conkieStats
				.on('error', function(err) {
					console.log(colors.blue('[Stats/Error]'), colors.red('ERR', err));
				})
				.on('update', function(stats) {
					if (program.debugStats) console.log(colors.blue('[Stats]'), JSON.stringify(stats, null, '\t'));
					var batStatus = _.get(stats, 'power[0].status');
					if (!onBattery && batStatus == 'discharging') {
						if (program.verbose > 1) console.log(colors.blue('[Stats]'), 'Detected battery mode - adjusting stats poll to', colors.cyan(program.refreshBattery + 'ms'));
						conkieStats.setPollFreq(program.refreshBattery);
						onBattery = true;
					} else if (onBattery && batStatus != 'discharging') {
						if (program.verbose > 1) console.log(colors.blue('[Stats]'), 'Detected powered mode - adjusting stats poll to', colors.cyan(program.refresh+ 'ms'));
						conkieStats.setPollFreq(program.refresh);
						onBattery = false;
					}
					win.webContents.send('updateStats', stats);
				})
				.setPollFreq(program.refresh);

			electron.ipcMain
				.on('statsRegister', function() {
					var mods = _.flatten(Array.prototype.slice.call(arguments).slice(1));
					if (program.debug) console.log(colors.blue('[Stats/Debug]'), 'Register stats modules', mods.map(function(m) { return colors.cyan(m) }).join(', '));
					conkieStats.register(mods);
				});

			electron.ipcMain
				.on('statsSettings', function(e, options) {
					if (program.verbose > 2) console.log(colors.blue('[Stats]'), 'Register stats settings', util.inspect(options, {depth: null, colors: true}));
					conkieStats.settings(options);
				});

			electron.ipcMain
				.on('setPosition', function(e, position) {
					if (program.debug) {
						console.log(colors.blue('[Conkie]'), 'Set window position', colors.red('ignored in debug mode'));
						return;
					}

					if (program.verbose > 2) console.log(colors.blue('[Conkie]'), 'Set window position', util.inspect(position, {depth: null, colors: true}));

					var mainScreen = electron.screen.getPrimaryDisplay();
					var calcPosition = boxSizing(position, {
						left: 10,
						top: 10,
						width: '33%',
						height: '33%',
						maxWidth: mainScreen.size.width,
						maxHeight: mainScreen.size.height,
					});

					if (program.verbose > 3) console.log(colors.blue('[Conkie]'), 'Set window position (actual)', util.inspect(calcPosition, {depth: null, colors: true}));

					if (calcPosition) {
						win.setBounds({
							x: calcPosition.left,
							y: calcPosition.top,
							width: calcPosition.width,
							height: calcPosition.height,
						});
					} else {
						if (program.verbose > 2) console.log(colors.blue('[Conkie/setPosition]'), colors.red('ERROR'), 'Invalid window position object', position);
					}
				});

			if (program.debug || program.verbose > 2) {
				conkieStats.on('debug', function(msg) {
					console.log(colors.blue('[Stats/Debug]'), colors.grey(msg));
				})
			}
			next();
		},
		// }}}
		// Apply X window styles {{{
		function(next) {
			if (program.debug) return next();
			async()
				.use(asyncExec)
				.execDefaults({
					log: function(cmd) {
						if (!program.verbose) return;
						console.log(colors.blue('[Conkie/XSetup]'), cmd.cmd + ' ' + cmd.params.join(' '));
					},
					out: function(line) {
						if (!program.verbose) return;
						line.split('\n').forEach(function(l) {
							console.log(colors.blue('[Conkie/XSetup]'), colors.grey('>'), l);
						});
					},
				})
				.exec([
					'wmctrl', 
					'-F',
					'-r',
					'Conkie',
					'-b',
					'add,below',
					'-vvv',
				])
				.exec([
					'wmctrl', 
					'-F',
					'-r',
					'Conkie',
					'-b',
					'add,sticky',
					'-vvv',
				])
				.end(next);
		},
		// }}}
		// (Optional) Watch theme directory if `--watch` is specified {{{
		function(next) {
			if (!program.watch) return next();

			var dir = fspath.dirname(program.theme);
			if (program.verbose > 1) console.log(colors.blue('[Conkie/Theme/Watcher]'), 'Watching', colors.cyan(dir));
			fs.watch(dir, {
				persistant: true,
				recursive: true,
			}, function(e, path) {
				if (program.verbose) console.log(colors.blue('[Conkie/Theme/Watcher]'), 'Detected', colors.cyan(e), 'on', colors.cyan(path));
				loadTheme(function(err) {
					if (err) {
						console.log(colors.blue('[Conkie/Theme/Watcher]'), colors.red('ERR'), 'Error while re-loading theme - ' + err.toString());
					} else {
						if (program.verbose) console.log(colors.blue('[Conkie/Theme/Watcher]'), 'Theme reloaded');
						win.webContents.reload();
					}
				});
			});
			next();
		},
		// }}}
	])
	.then(function(next) {
		// Everything done - wait for window to terminate {{{
		win.on('closed', function() {
			next();
		});
		// }}}
	})
	.end(function(err) {
		// Clean up references {{{
		if (app) app.quit();
		win = null; // Remove reference and probably terminate the program
		// }}}

		// Handle exit state {{{
		if (err) {
			console.log(colors.blue('[Conkie]'), colors.red('ERR', err.toString()));
			process.exit(1);
		} else {
			console.log(colors.blue('[Conkie]'), 'Exit');
			process.exit(0);
		}
		// }}}
	});
