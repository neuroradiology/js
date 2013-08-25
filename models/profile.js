var Profile = Composer.RelationalModel.extend({
	relations: {
		boards: {
			type: Composer.HasMany,
			collection: 'Boards',
			forward_events: true
		}
	},

	// stores whether or not all profile data has been downloaded
	profile_data: false,

	// tracks items to ignore when a sync occurs. this is useful for ignoring
	// things that the user just changed which can overwrite data with older
	// versions.
	sync_ignore: [],

	// timer for persisting
	persist_timer: null,

	init: function()
	{
		this.bind_relational('boards', 'destroy', function(board) {
			if(this.get_current_board() == board)
			{
				this.set_current_board(this.get('boards').first());
			}
		}.bind(this));
		var profile_mod_timer	=	new Timer(100);
		profile_mod_timer.end	=	function()
		{
			if(window.port) window.port.send('profile-mod');
		};
		this.bind_relational('boards', ['add', 'remove', 'reset', 'change', 'note_change'], function() {
			this.persist();
			profile_mod_timer.start();
		}.bind(this));
		this.persist_timer		=	new Timer(200);
		this.persist_timer.end	=	false;
	},

	load_data: function(options)
	{
		var success = function(profile, from_storage)
		{
			from_storage || (from_storage = false);

			this.profile_data = true;
			turtl.user.set(profile.user);
			if(options.init)
			{
				//this.clear({silent: true});
				this.load(profile, Object.merge({}, options, {
					complete: function() {
						if(options.success) options.success(profile, from_storage);
					}.bind(this)
				}));
			}
			else if(options.success)
			{
				options.success(profile, from_storage);
			}
		}.bind(this);

		// load from addon
		if((profile = (window._profile || false)) !== false)
		{
			// this next line recursively wraps the profile as mootools objects/arrays
			profile	=	data_from_addon(profile);
			(function () { success(profile, true); }).delay(0);
		}
		// load from local storage mirror
		else if((profile = this.from_persist()) !== false)
		{
			(function () { success(profile, true); }).delay(0);
		}
		// load from API
		else
		{
			turtl.api.get('/profiles/users/'+turtl.user.id(), {}, {
				success: function(profile) {
					success(profile, false);
				},
				error: function(err) {
					barfr.barf('Error loading user profile: '+ err);
					if(options.error) options.error(e);
				}
			});
		}
	},

	load: function(data, options)
	{
		options || (options = {});
		var boards = this.get('boards');
		var board_data = data.boards;
		boards.load_boards(board_data, Object.merge({}, options, {
			complete: function() {
				var board = null;
				this.loaded = true;
				if(options.board)
				{
					board = this.get('boards').find(function(p) {
						return p.id() == options.board.clean();
					});
				}
				if(!board) board = this.get('boards').first();
				if(board) this.set_current_board(board);
				if(options.complete) options.complete();
			}.bind(this)
		}));
	},

	/**
	 * Grab all profile/persona profile data and init it into this profile
	 * object.
	 */
	initial_load: function(options)
	{
		options || (options = {});
		this.load_data({
			init: true,
			success: function() {
				// message data can be loaded independently once personas
				// are loaded, so do it
				turtl.messages.sync();
				this.trigger('loaded');
				if(options.complete) options.complete();
			}.bind(this)
		});
	},

	get_current_board: function()
	{
		var cur	=	this.get('current_board', false);
		if(!cur) cur = this.get('boards').first();
		return cur;
	},

	set_current_board: function(obj, options)
	{
		options || (options = {});
		return this.set({current_board: obj}, options);
	},

	/**
	 * Keeps track of items to IGNORE when a sync happens
	 */
	track_sync_changes: function(id)
	{
		this.sync_ignore.push(id);
	},

	sync: function(options)
	{
		options || (options = {});
		if(!turtl.sync || !turtl.user.logged_in) return false;

		var sync_time = this.get('sync_time', 9999999);
		turtl.api.post('/sync', {time: sync_time}, {
			success: function(sync) {
				this.set({sync_time: sync.time});
				this.process_sync(sync, options);
				// reset ignore list
				this.sync_ignore	=	[];
			}.bind(this),
			error: function(e, xhr) {
				if(xhr.status == 0)
				{
					barfr.barf(
						'Error connecting with server. Your changes may not be saved.<br><br><a href="#" onclick="window.location.reload()">Try reloading</a>.',
						{message_persist: 'persist'}
					);
				}
				else
				{
					barfr.barf('Error syncing user profile with server: '+ e);
				}
				if(options.error) options.error(e);
			}.bind(this)
		});

		turtl.messages.sync({
			success: function(_, persona) {
				persona.sync_data(sync_time);
			}
		});
	},

	process_sync: function(sync, options)
	{
		options || (options = {});

		// send synced data to addon
		if(window.port && turtl.sync && sync)
		{
			window.port.send('profile-sync', sync);
		}

		// if we're syncing user data, update it
		if(sync.user && (!turtl.sync || !window._in_ext))
		{
			turtl.user.set(sync.user);
		}

		sync.boards.each(function(board_data) {
			// don't sync ignored items
			if(this.sync_ignore.contains(board_data.id))
			{
				this.sync_ignore.erase(board_data.id);
				return false;
			}

			var board	=	turtl.profile.get('boards').find_by_id(board_data.id);
			if(board_data.deleted)
			{
				if(board) board.destroy({skip_sync: true});
			}
			else if(board)
			{
				board.set(board_data);
			}
			else
			{
				turtl.profile.get('boards').upsert(new Board(board_data));
			}
		}.bind(this));
		this.persist(options);

		sync.notes.each(function(note_data) {
			// don't sync ignored items
			if(this.sync_ignore.contains(note_data.id))
			{
				this.sync_ignore.erase(note_data.id);
				return false;
			}

			// check if the note is already in an existing board. if
			// so, save both the original board (and existing note)
			// for later
			var oldboard = false;
			var note = false;
			this.get('boards').each(function(p) {
				if(note) return;
				note = p.get('notes').find_by_id(note_data.id)
				if(note) oldboard = p;
			});

			// get the note's current board
			var newboard	=	this.get('boards').find_by_id(note_data.board_id);

			// note was deleted, remove it
			if(note && note_data.deleted)
			{
				oldboard.get('notes').remove(note);
				note.destroy({skip_sync: true});
				note.unbind();
			}
			// this is an existing note. update it, and be mindful of the
			// possibility of it moving boards
			else if(note && oldboard)
			{
				note.set(note_data);
				if(newboard && oldboard.id() != newboard.id())
				{
					// note switched board IDs. move it.
					oldboard.get('notes').remove(note);
					newboard.get('notes').add(note);
				}
			}
			// note isn't existing and isn't being deleted. add it!
			else if(!note_data.deleted && newboard)
			{
				newboard.get('notes').add(note_data);
			}
		}.bind(this));
	},

	get_sync_time: function()
	{
		if(this.get('sync_time', false)) return;

		turtl.api.get('/sync', {}, {
			success: function(time) {
				this.set({sync_time: time});
			}.bind(this),
			error: function(e) {
				barfr.barf('Error syncing user profile with server: '+ e);
			}.bind(this)
		});
	},

	persist: function(options)
	{
		options || (options = {});

		var do_persist	=	function(options)
		{
			options || (options = {});
			var store	=	{
				user: turtl.user.toJSON(),
				boards: []
			};
			turtl.profile.get('boards').each(function(board) {
				var boardobj	=	board.toJSON();
				boardobj.notes	=	board.get('notes').toJSON();
				store.boards.push(boardobj);
			});
			var tsnow	=	Math.floor(new Date().getTime()/1000);
			store.time	=	this.get('sync_time', tsnow);
			if(window.port) window.port.send('profile-save', store);

			if(!turtl.mirror) return false;

			localStorage['profile:user:'+turtl.user.id()]	=	JSON.encode(store);
			localStorage['scheme_version']					=	config.mirror_scheme_version;
		}.bind(this);

		if(options.now)
		{
			do_persist(options);
		}
		else
		{
			this.persist_timer.end	=	function() { do_persist(options); };
			this.persist_timer.start();
		}
	},

	from_persist: function()
	{
		if(!turtl.mirror) return false;

		if((localStorage['scheme_version'] || 0) < config.mirror_scheme_version)
		{
			localStorage.clear();
			return false;
		}
		var data	=	localStorage['profile:user:'+turtl.user.id()] || false
		if(data) data = JSON.decode(data);
		if(data && data.time) this.set({sync_time: data.time});
		return data;
	}
});

