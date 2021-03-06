/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */
var mod_assertplus = require('assert-plus');
var mod_events = require('events');
var mod_fs = require('fs');
var mod_fsm = require('mooremachine');
var mod_bunyan = require('bunyan');
var mod_mkdirp = require('mkdirp');
var mod_moray = require('moray');
var mod_getopt = require('posix-getopt');
var mod_morayfilter = require('moray-filter');
var mod_sdc = require('sdc-clients');
var mod_path = require('path');
var mod_sqlite = require('sqlite3');
var mod_util = require('util');
var mod_vasync = require('vasync');
var mod_verror = require('verror');

var VError = mod_verror.VError;

var LOG;
var DEFAULT_BATCH_SIZE = 10000;
var INSTRUCTION_OBJECT_NAME_BYTE_LENGTH = 135;
var INSTRUCTION_OBJECT_NUM_COMPONENTS = 6;

function MakoGcFeeder(opts)
{
	var self = this;

	mod_assertplus.optionalNumber(opts.batch_size, 'opts.batch_size');
	mod_assertplus.object(opts.log, 'opts.log');
	mod_assertplus.string(opts.start, 'opts.start');
	mod_assertplus.string(opts.end, 'opts.end');
	mod_assertplus.string(opts.sapi_url, 'opts.sapi_url');
	mod_assertplus.string(opts.shard_domain, 'opts.shard_domain');
	mod_assertplus.string(opts.nameservice, 'opts.nameservice');
	mod_assertplus.string(opts.poseidon_uuid, 'opts.poseidon_uuid');
	mod_assertplus.string(opts.instruction_list_dir, 'opts.instruction_list_dir');
	mod_assertplus.string(opts.stream_pos_db_dir, 'opts.stream_pos_db_dir');

	this.f_instruction_list_dir = opts.instruction_list_dir;
	this.f_stream_pos_db_dir = opts.stream_pos_db_dir;
	this.f_poseidon_uuid = opts.poseidon_uuid;
	this.f_lastFindObjects = null;

	this.f_log = opts.log.child({ component: 'MakoGcFeeder-' + opts.shard_domain });

	this.f_shard = opts.shard_domain;
	this.f_nameservice = opts.nameservice;
	this.f_batch_size = opts.batch_size || DEFAULT_BATCH_SIZE;

	/*
	 * Moray client used by this feeder. Each has exactly one.
	 */
	this.f_morayclient = mod_moray.createClient({
	    log: self.f_log.child({
		component: 'MorayClient-' + self.f_shard,
	    }),
	    srvDomain: self.f_shard,
	    cueballOptions: {
		resolvers: [ self.f_nameservice ],
		defaultPort: 2020
	    }
	});

	/*
	 * SAPI client to determine the range of storage ids we're listing
	 * instructions for.
	 */
	this.f_sapi = new mod_sdc.SAPI({
		url: opts.sapi_url,
		log: this.f_log.child({ component: 'sapi' }),
		agent: false,
		version: '*'
	});

	/*
	 * The last error seen by this feeder.
	 */
	this.f_lastErr = null;

	/*
	 * Filter to be used for the next findobjects.
	 */
	this.f_morayfilter = null;

	/*
	 * Delay between findobjects rpcs.
	 */
	this.f_delay = 0;

	/*
	 * For each storage_id we find in Moray, we save a descriptor object
	 * that contains a write stream for the file to which we're writing
	 * instructions for that storage_id.
	 */
	this.f_filestreams = {};

	/*
	 * Last path seen by the program.
	 */
	this.f_numLastSeen = 0;

	/*
	 * Total number of paths seen by the program.
	 */
	this.f_numseen = 0;
	this.f_numwritten = 0;

	/*
	 * SQLite db used to store stream position.
	 */
	this.f_db_path = [
	    this.f_stream_pos_db_dir,
	    this.f_shard + '-stream_position.db'
	].join('/');
	this.f_db = null;

	/*
	 * Range of possible _key s. See state_init.
	 */
	this.f_start = opts.start;
	this.f_prev = null;
	this.f_end = opts.end;

	mod_fsm.FSM.call(this, 'init');
};
mod_util.inherits(MakoGcFeeder, mod_fsm.FSM);

MakoGcFeeder.prototype.updateMorayFilter = function ()
{
	var self = this;
	/*
	 * Set up moray filter for findobjects.
	 */
	var filter = new mod_morayfilter.AndFilter();
	filter.addFilter(new mod_morayfilter.GreaterThanEqualsFilter({
		attribute: '_key',
		value: self.f_start
	}));
	filter.addFilter(new mod_morayfilter.LessThanEqualsFilter({
		attribute: '_key',
		value: self.f_end
	}));
	filter.addFilter(new mod_morayfilter.EqualityFilter({
		attribute: 'type',
		value: 'object'
	}));
	self.f_morayfilter = filter.toString();
};

MakoGcFeeder.prototype.state_init = function (S)
{
	var self = this;

	mod_vasync.pipeline({ funcs: [
		function createStreamDbTmpDirs(_, next) {
			mod_mkdirp(self.f_stream_pos_db_dir, next);
		},
		function initdb(_, next) {
			self.f_db = new mod_sqlite.Database(self.f_db_path);
			next();
		},
		/*
		 * Create a sqlite database storing the latest _key found in the
		 * stream.
		 */
		function createDatabase(_, next) {
			self.f_db.run('CREATE TABLE IF NOT EXISTS stream_position ' +
			    '(timestamp TEXT, marker TEXT)', next);
		},
		/*
		 * If this program crashed and restarted, it's possible for us
		 * to resume it from the last _key it read in it's previous run.
		 */
		function checkForPreviousRun(_, next) {
			self.f_db.get('SELECT * FROM stream_position',
			    function (serr, row) {
				if (serr) {
					next(new VError('Unable to determine ' +
					    'stream position \'%s\'', serr));
					return;
				}
				/*
				 * If we have a stream_position table, but it
				 * dones't have a marker -- create one.
				 */
				if (row === undefined) {
					var args = [
					    (new Date()).toISOString(),
					    self.f_start
					];
					self.f_db.run('INSERT INTO stream_position ' +
					    'VALUES (?, ?)', args);
					next();
					return;
				}

				if (!row.hasOwnProperty('marker')) {
					next(new VError('Malformed stream_position ' +
					    'table. Missing \'marker\' column.'));
					return;
				} else {
					self.f_log.info('Resuming scan from previous ' +
					    'run at \'%s\'', row['marker']);
				}

				self.f_start = row['marker'] || self.f_start;

				next();
			});
		},
		/*
		 * Instruction object listings with metadata on 'SHARD_URL' for
		 * shrimp with manta_sorage_id 'STORAGE_ID' are stored in:
		 *
		 * /var/tmp/mako_gc_inputs/SHARD_URL/STORAGE_ID
		 */
		function createListingDirectories(_, next) {
			mod_mkdirp([self.f_instruction_list_dir, self.f_shard].join('/'),
			    function (err) {
				self.f_log.debug('Created local listing directories');
				next(err);
			});
		},
		/*
		 * Connect to Moray.
		 */
		function waitForMorayConnection(_, next) {
			self.f_log.debug('Waiting for Moray connection');
			if (self.f_morayclient.connected) {
				next();
				return;
			}
			self.f_morayclient.once('connect', function () {
				self.f_log.debug('Moray client connected.');
				next();
			});
		}
	] }, function (err) {
		if (err) {
			self.f_log.error('Error initializing: \'%s\'', err);
			self.f_lastErr = err;

			S.gotoState('done');
			return;
		}

		self.f_log.debug('Finished initializing');

		S.gotoState('running');
	});
}

MakoGcFeeder.prototype.state_running = function (S)
{
	var self = this;

	self.readChunk(function (err) {
		/*
		 * The upper bound on the _key range we're searching is
		 * exclusive. This means that even when we've processed the
		 * entire range of instruction objects on a shard, we'll always
		 * still receive one more record if we try restarting the
		 * process.
		 *
		 * If `err` is not undefined here, we have already logged it in
		 * `readChunk`.
		 */
		if (!err) {
			if (self.f_numLastSeen === 0 || (self.f_numLastSeen === 1 &&
			    self.f_batch_size > 1)) {
				S.gotoState('done');
				return;
			}
		}
		setTimeout(function () {
			S.gotoState('running');
		}, self.f_delay);
	});
};

MakoGcFeeder.prototype.state_done = function (S)
{
	var self = this;

	mod_vasync.forEachParallel({
		inputs: Object.keys(self.f_filestreams),
		func: function (storage_id, done) {
			var entry = self.f_filestreams[storage_id];

			entry.stream.on('finish', function () {
				self.f_log.info('Finished writing \'%s\'',
				    entry.path);
				done();
			});
			entry.stream.end();
		}
	}, function (err) {
		/*
		 * Close stream position database.
		 */
		self.f_db.close();
	});
};

/*
 * Instruction objects are stored in /poseidon/stor/manta_gc/mako/<storage_id>.
 * We extract the storage_id from the path here.
 */
function extractStorageId(path)
{
	// Subtract 1 to account for leading '/'.
	return (path.split('/')[INSTRUCTION_OBJECT_NUM_COMPONENTS - 1]);
}

function unresolvePath(path)
{
	var components = path.split('/');

	/*
	 * All paths have a leading '/', so poseidon's uuid will appear at index
	 * 1 in this array.
	 */
	components[1] = 'poseidon';

	return (components.join('/'));
}

MakoGcFeeder.prototype.checkpoint = function ()
{
	var self = this;
	self.f_db.run('UPDATE stream_position SET timestamp = ?, marker = ?',
	    [(new Date()).toISOString(), self.f_start]);
};

MakoGcFeeder.prototype.appendToListingFile = function (path)
{
	var self = this;
	var storage_id = extractStorageId(path);

	var unresolvedPath = unresolvePath(path);

	var file = [self.f_instruction_list_dir, self.f_shard, storage_id].join('/');

	/*
	 * If this is the first time we're writing to this file, establish a
	 * write stream.
	 */
	if (!self.f_filestreams.hasOwnProperty(storage_id)) {
		self.f_filestreams[storage_id] = {
			lastError: null,
			/*
			 * Append-only. We may be resuming the listing after
			 * crashing.
			 */
			stream: mod_fs.createWriteStream(file, {
			    flags: 'a'
			}),
			path: file
		};
		self.f_filestreams[storage_id].stream.on('error',
		    function (err) {
			self.f_filestreams[storage_id].lastError = err;
			self.f_log.error('Error writing file \'%s\': \'%s\'',
			    file, err);
		});
	}

	if (self.f_prev == null || self.f_start !== self.f_prev) {
		self.f_filestreams[storage_id].stream.write(unresolvedPath + '\n');
		self.f_numwritten++;
	}

	/*
	 * Save the previous path so that we don't duplicate batch endpoints.
	 */
	self.f_prev = self.f_start;
	/*
	 * Advance our marker. Note that we advanced to the 'resolved' path (the
	 * one with poseidon's uuid and not login).
	 */
	self.f_start = path;
};

MakoGcFeeder.prototype.readChunk = function (cb) {
	var self = this;

	/*
	 * Make sure we've got the most up-to-date bounds.
	 */
	self.updateMorayFilter();

	var findOpts = {
		limit: self.f_batch_size,
		sort: {
			attribute: '_key',
			order: 'ASC'
		},
		no_count: true
	};

	self.f_numLastSeen = 0;

	mod_assertplus.ok(self.f_lastFindObjects === null, 'self.f_lastFindObjects === null');
	self.f_lastFindObjects = Date.now();
	var startTime = self.f_lastFindObjects;

	var req = self.f_morayclient.findObjects('manta', self.f_morayfilter,
	    findOpts);

	req.on('record', function (record) {
		mod_assertplus.ok(startTime === self.f_lastFindObjects,
		    'startTime == self.f_lastFindObjects');
		var key = record.key;

		self.f_numLastSeen++;
		self.f_numseen++;

		var err = self.appendToListingFile(key);
		if (err) {
			self.f_log.error('Error writing to listing \'%s\'', key);
			return;
		}
	});

	req.once('error', function (err) {
		mod_assertplus.ok(startTime === self.f_lastFindObjects,
		    'startTime === self.f_lastFindObjects');

		self.f_lastFindObjects = null;

		self.f_log.error('Error listing records: \'%s\'', err);
		cb(err);
	});

	req.once('end', function () {
		mod_assertplus.ok(startTime === self.f_lastFindObjects,
		    'startTime === self.f_lastFindObjects');
		self.checkpoint();
		self.f_lastFindObjects = null;

		self.f_log.info({
		    seenNow: self.f_numLastSeen,
		    seenCumulative: self.f_numseen,
		    numWritten: self.f_numwritten
		}, 'findobjects: done');
		cb();
	});
};

function main()
{
	var opts;
	var file = mod_path.join('etc', 'config.json');
	var feeders = {};

	var option;
	var parser = new mod_getopt.BasicParser('f:(file)', process.argv);

	while ((option = parser.getopt()) !== undefined) {
		switch (option.option) {
		case 'f':
			file = option.optarg;
			break;
		default:
			mod_assertplus.equal('?', option.option);
			process.exit(1);
			break;
		}
	}

	LOG = mod_bunyan.createLogger({
	    name: 'Main',
	    level: process.env.LOG_LEVEL || 'info'
	});

	mod_fs.readFile(file, function (err, data) {
		if (err) {
			throw (err);
		}
		try {
			opts = JSON.parse(data.toString('utf8'));
		} catch (e) {
			throw (e);
		}

		mod_assertplus.arrayOfObject(opts.shards, 'opts.shard');
		mod_assertplus.string(opts.nameservice, 'opts.nameservice');
		mod_assertplus.number(opts.batch_size, 'opts.batch_size');
		mod_assertplus.string(opts.poseidon_uuid, 'opts.poseidon_uuid');
		mod_assertplus.string(opts.instruction_list_dir, 'opts.instruction_list_dir');
		mod_assertplus.string(opts.stream_pos_db_dir, 'opts.stream_pos_db_dir');

		opts.log = LOG;

		/*
		 * SAPI client to determine the range of storage ids we're listing
		 * instructions for.
		 */
		var sapi = new mod_sdc.SAPI({
			url: opts.sapi_url,
			log: LOG.child({ component: 'sapi' }),
			agent: false,
			version: '*'
		});

		mod_vasync.pipeline({ arg: opts, funcs: [
			function getStorageIdRange(arg, next) {
				var listOpts = {
				    name: 'storage',
				    include_master: true
				}
				sapi.listServices(listOpts, function (err, services) {
					if (err) {
						next(new VError('Unable to find storage ' +
						    'service: \'%s\'', err));
						return;
					}
					var storage_svc_uuids = services.map(function (service) {
						return (service.uuid);
					});
					if (storage_svc_uuids.length === 0) {
						next(new VError('No storage service found'));
						return;
					} else if (storage_svc_uuids.length > 1) {
						next(new VError('Multiple storage services ' +
						    'found'));
						return;
					}
					arg.storage_svc_uuid = storage_svc_uuids[0];
					var listInstOpts = {
						service_uuid: arg.storage_svc_uuid,
						include_master: true
					};

					sapi.listInstances(listInstOpts,
					    function (err, instances) {
						if (err) {
							next(new VError('Error listing storage instances ' +
							    '\'%s\'', err));
							return;
						}
						arg.storage_ids = instances.map(function (instance) {
							return (instance.params.tags.manta_storage_id);
						});
						if (arg.storage_ids.length === 0) {
							next (new VError('No storage instances found!'));
							return;
						}
						LOG.debug({
							storage_ids: mod_util.inspect(
							    arg.storage_ids)
						}, 'Found storage ids');
						next();
					});
				});
			},
			/*
			 * Having loaded this list of storage ids, we now determine the
			 * storage node with the minimum and maximum storage identifier.
			 * This is generally the first part of the manta_storage_id, as
			 * in:
			 *
			 * 1.stor.DOMAIN_NAME, 1015.stor.DOMAIN_NAME
			 *
			 * There is nothing in Manta that enforces that storage nodes
			 * are named with integer domain names, but it is a convention
			 * that is used in all major Manta deployments.
			 */
			function setStorageIdBounds(arg, next) {
				var min = 0;
				var max = 0;
				for (var i = 0; i < arg.storage_ids.length; i++) {
					var storage_id = arg.storage_ids[i];
					var storage_no;
					try {
						storage_no = parseInt(storage_id.split('.')[0]);
					} catch (e) {
						next(new VError(err, 'Unable to parse numeric ' +
						    'domain from \'%s\'', storage_id));
						return;
					}
					if (storage_no < min || min === 0) {
						arg.storage_id_start = storage_id;
						min = storage_no;
					}
					if (storage_no > max || max === 0) {
						arg.storage_id_end = storage_id;
						max = storage_no;
					}
				}

				/*
				 * Make sure to terminate this string with '/',
				 * otherwise we might pull in
				 * /poseidon/stor/manta_gc/mako/1.stor.orbit.example.com,
				 * which is not necessarily stored on the same
				 * shard as the instruction objects are.
				 */
				arg.start = ['', arg.poseidon_uuid, 'stor',
				    'manta_gc', 'mako', ''].join('/');

				var storage_id_upper = arg.storage_id_end.split('.');
				storage_id_upper[0] = '~'.repeat(Buffer.byteLength(storage_id_upper[0]));

				/*
				 * The ASCII '~' compares greater than or equal to any
				 * other ASCII character under PostgreSQL's lexical
				 * comparison operator.
				 */
				arg.end = ['', arg.poseidon_uuid, 'stor',
				    'manta_gc', 'mako', storage_id_upper.join('.'),
				    '~'.repeat(INSTRUCTION_OBJECT_NAME_BYTE_LENGTH)].join('/');

				next();
			}
		] }, function (err) {
			if (err) {
				throw (err);
			}

			mod_assertplus.string(opts.start, 'opts.start');
			mod_assertplus.string(opts.end, 'opts.end');

			opts.shards.forEach(function (shard) {
				mod_assertplus.string(shard.host, 'shard.host');
				var options = {
					log: opts.log,
					batch_size: opts.batch_size,
					sapi_url: opts.sapi_url,
					shard_domain: shard.host,
					nameservice: opts.nameservice,
					poseidon_uuid: opts.poseidon_uuid,
					start: opts.start,
					end: opts.end,
					instruction_list_dir: opts.instruction_list_dir,
					stream_pos_db_dir: opts.stream_pos_db_dir
				};
				feeders[shard.host] = new MakoGcFeeder(options);
			});
		});
	});
}

main();
