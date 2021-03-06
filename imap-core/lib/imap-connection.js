'use strict';

const IMAPStream = require('./imap-stream').IMAPStream;
const IMAPCommand = require('./imap-command').IMAPCommand;
const IMAPComposer = require('./imap-composer').IMAPComposer;
const imapTools = require('./imap-tools');
const search = require('./search');
const dns = require('dns');
const crypto = require('crypto');
const os = require('os');
const EventEmitter = require('events').EventEmitter;
const packageInfo = require('../../package');

const SOCKET_TIMEOUT = 30 * 60 * 1000;

/**
 * Creates a handler for new socket
 *
 * @constructor
 * @param {Object} server Server instance
 * @param {Object} socket Socket instance
 */
class IMAPConnection extends EventEmitter {
    constructor(server, socket) {
        super();

        // Random session ID, used for logging
        this.id = crypto.randomBytes(9).toString('base64');

        this.compression = false;
        this._deflate = false;
        this._inflate = false;

        this._server = server;
        this._socket = socket;

        this.writeStream = new IMAPComposer({
            connection: this
        });
        this.writeStream.pipe(this._socket);
        this.writeStream.on('error', this._onError.bind(this));

        // session data (envelope, user etc.)
        this.session = false;

        // If true then the connection is currently being upgraded to TLS
        this._upgrading = false;

        // Parser instance for the incoming stream
        this._parser = new IMAPStream();

        // Set handler for incoming commands
        this._parser.oncommand = this._onCommand.bind(this);

        // Manage multi part command
        this._currentCommand = false;

        // If set, then data payload is not executed as a command but as an argument for this function
        this._nextHandler = false;

        // If true, then the connection is using TLS
        this.secure = !!this._server.options.secure;

        // Store remote address for later usage
        this.remoteAddress = this._socket.remoteAddress;

        // Server hostname for the greegins
        this.name = (this._server.options.name || os.hostname()).toLowerCase();

        this.state = 'Not Authenticated';

        this._listenerData = false;

        // selected mailbox metadata
        this.selected = false;

        // ignore timeouts if true
        this.idling = false;

        // indicates if CONDSTORE is enabled for the session
        this.condstoreEnabled = false;

        // Resolved hostname for remote IP address
        this.clientHostname = false;

        // increment connection count
        this._closing = false;
        this._closed = false;
    }

    /**
     * Initiates the connection. Checks connection limits and reverse resolves client hostname. The client
     * is not allowed to send anything before init has finished otherwise 'You talk too soon' error is returned
     */
    init() {
        // Setup event handlers for the socket
        this._setListeners();

        // Resolve hostname for the remote IP
        // we do not care for errors as we consider the ip as unresolved in this case, no big deal
        dns.reverse(this.remoteAddress, (err, hostnames) => {
            if (err) {
                //ignore, no big deal
            }

            // eslint-disable-line handle-callback-err
            if (this._closing || this._closed) {
                return;
            }

            this.clientHostname = (hostnames && hostnames.shift()) || '[' + this.remoteAddress + ']';

            this._startSession();

            this._server.logger.info(
                {
                    tnx: 'connect',
                    cid: this.id
                },
                '[%s] Connection from %s',
                this.id,
                this.clientHostname
            );
            this.send('* OK ' + ((this._server.options.id && this._server.options.id.name) || packageInfo.name) + ' ready');
        });
    }

    /**
     * Send data to socket
     *
     * @param {Number} code Response code
     * @param {String|Array} data If data is Array, send a multi-line response
     */
    send(payload, callback) {
        if (this._socket && this._socket.writable) {
            this[!this.compression ? '_socket' : '_deflate'].write(payload + '\r\n', 'binary', callback);
            if (this.compression) {
                // make sure we transmit the message immediatelly
                this._deflate.flush();
            }
            this._server.logger.debug(
                {
                    tnx: 'send',
                    cid: this.id
                },
                '[%s] S:',
                this.id,
                payload
            );
        }
    }

    /**
     * Close socket
     */
    close() {
        if (!this._socket.destroyed && this._socket.writable) {
            this._socket.end();
        }

        this._server.connections.delete(this);

        this._closing = true;
    }

    // PRIVATE METHODS

    /**
     * Setup socket event handlers
     */
    _setListeners() {
        this._socket.on('close', this._onClose.bind(this));
        this._socket.on('end', this._onEnd.bind(this));
        this._socket.on('error', this._onError.bind(this));
        this._socket.setTimeout(this._server.options.socketTimeout || SOCKET_TIMEOUT, this._onTimeout.bind(this));
        this._socket.pipe(this._parser);
    }

    /**
     * Fired when the socket is closed
     * @event
     */
    _onEnd() {
        this._server.logger.info(
            {
                tnx: 'close',
                cid: this.id
            },
            '[%s] Connection END',
            this.id
        );
        if (!this._closed) {
            this._onClose();
        }
    }

    /**
     * Fired when the socket is closed
     * @event
     */
    _onClose(/* hadError */) {
        if (this._closed) {
            return;
        }

        this._parser = false;

        this.state = 'Closed';

        if (this._dataStream) {
            this._dataStream.unpipe();
            this._dataStream = null;
        }

        if (this._deflate) {
            this._deflate = null;
        }

        if (this._inflate) {
            this._inflate = null;
        }

        if (this._listenerData) {
            this._listenerData.clear();
        }

        this._server.connections.delete(this);

        if (this._closed) {
            return;
        }

        this._closed = true;
        this._closing = false;

        this._server.logger.info(
            {
                tnx: 'close',
                cid: this.id
            },
            '[%s] Connection closed to %s',
            this.id,
            this.clientHostname
        );
    }

    /**
     * Fired when an error occurs with the socket
     *
     * @event
     * @param {Error} err Error object
     */
    _onError(err) {
        if (err.processed) {
            return;
        }
        if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
            this.close(); // mark connection as 'closing'
            return;
        }

        this._server.logger.error(
            {
                err,
                cid: this.id
            },
            '[%s] %s',
            this.id,
            err.message
        );
        this.emit('error', err);
    }

    /**
     * Fired when socket timeouts. Closes connection
     *
     * @event
     */
    _onTimeout() {
        this._server.logger.info(
            {
                tnx: 'connection',
                cid: this.id
            },
            '[%s] Connection TIMEOUT',
            this.id
        );
        if (this.idling) {
            return; // ignore timeouts when IDLEing
        }
        this.send('* BYE Idle timeout, closing connection');
        this.close();
    }

    /**
     * Checks if a selected command is available and ivokes it
     *
     * @param {Buffer} command Single line of data from the client
     * @param {Function} callback Callback to run once the command is processed
     */
    _onCommand(command, callback) {
        let currentCommand = this._currentCommand;

        callback = callback || (() => false);

        if (this._upgrading) {
            // ignore any commands before TLS upgrade is finished
            return callback();
        }

        if (!currentCommand) {
            this._currentCommand = currentCommand = new IMAPCommand(this);
        }

        if (!command.final) {
            currentCommand.append(command, callback);
        } else {
            this._currentCommand = false;
            currentCommand.end(command, callback);
        }
    }

    /**
     * Sets up a new session
     */
    _startSession() {
        this.session = {
            id: this.id,

            selected: this.selected,

            remoteAddress: this.remoteAddress,
            clientHostname: this.clientHostname,
            writeStream: this.writeStream,
            socket: this._socket,

            formatResponse: this.formatResponse.bind(this),
            getQueryResponse: imapTools.getQueryResponse,
            matchSearchQuery: search.matchSearchQuery,

            isUTF8Enabled: () => this.acceptUTF8Enabled
        };
    }

    /**
     * Sets up notification listener from upstream
     *
     * @param {Function} done Called once listeners are updated
     */
    updateNotificationListener(done) {
        if (this._listenerData) {
            if (!this.selected || this._listenerData.mailbox !== this.selected.mailbox) {
                // registered against some mailbox, unregister from it
                this._listenerData.clear();
            } else if (this._listenerData.mailbox === this.selected.mailbox) {
                // already registered
                return done();
            }
        }

        if (!this.selected) {
            this._listenerData = false;
            return done();
        }

        let cleared = false;
        let listenerData = (this._listenerData = {
            mailbox: this.selected.mailbox,
            lock: false,
            clear: () => {
                this._server.notifier.removeListener(this.session, listenerData.mailbox, listenerData.callback);
                if (listenerData === this._listenerData) {
                    this._listenerData = false;
                }
                listenerData = false;
                cleared = true;
            },
            callback: message => {
                if (message) {
                    if (this.selected && message.action === 'DELETE' && message.mailbox === this.selected.mailbox) {
                        this.send('* BYE Selected mailbox was deleted, have to disconnect');
                        this.close();
                        return;
                    }
                }

                if (listenerData.lock) {
                    // race condition, do not allow fetching data before previous fetch is finished
                    return;
                }

                if (cleared) {
                    // some kind of a race condition, just ignore
                    return;
                }

                // if not selected anymore, remove itself
                if (this.state !== 'Selected' || !this.selected) {
                    listenerData.clear();
                    return;
                }

                listenerData.lock = true;
                this._server.notifier.getUpdates(this.session, this._listenerData.mailbox, this.selected.modifyIndex, (err, updates) => {
                    if (cleared) {
                        // client probably switched mailboxes while processing, just ignore all results
                        return;
                    }
                    listenerData.lock = false;

                    if (err) {
                        this._server.logger.info(
                            {
                                err,
                                tnx: 'updates',
                                cid: this.id
                            },
                            '[%s] Notification Error: %s',
                            this.id,
                            err.message
                        );
                        return;
                    }

                    // if not selected anymore, remove itself
                    if (this.state !== 'Selected' || !this.selected) {
                        listenerData.clear();
                        return;
                    }

                    if (!updates || !updates.length) {
                        return;
                    }

                    // store new incremental modify index
                    if (updates[updates.length - 1].modseq > this.selected.modifyIndex) {
                        this.selected.modifyIndex = updates[updates.length - 1].modseq;
                    }

                    // append received notifications to the list
                    this.selected.notifications = this.selected.notifications.concat(updates);
                    if (this.idling) {
                        // when idling emit notifications immediatelly
                        this.emitNotifications();
                    }
                });
            }
        });

        this._server.notifier.addListener(this.session, this._listenerData.mailbox, this._listenerData.callback);

        return done();
    }

    // send notifications to client
    emitNotifications() {
        if (this.state !== 'Selected' || !this.selected || !this.selected.notifications.length) {
            return;
        }

        let changed = false;
        let existsResponse;

        // show notifications
        this._server.logger.info(
            {
                tnx: 'notifications',
                cid: this.id
            },
            '[%s] Pending notifications: %s',
            this.id,
            this.selected.notifications.length
        );

        // find UIDs that are both added and removed
        let added = new Set(); // added UIDs
        let removed = new Set(); // removed UIDs
        let skip = new Set(); // UIDs that are removed before ever seen

        for (let i = 0, len = this.selected.notifications.length; i < len; i++) {
            let update = this.selected.notifications[i];
            if (update.command === 'EXISTS') {
                added.add(update.uid);
            } else if (update.command === 'EXPUNGE') {
                removed.add(update.uid);
            }
        }

        removed.forEach(uid => {
            if (added.has(uid)) {
                skip.add(uid);
            }
        });

        // filter multiple FETCH calls, only keep latest, otherwise might mess up MODSEQ responses
        let fetches = new Set();
        for (let i = this.selected.notifications.length - 1; i >= 0; i--) {
            let update = this.selected.notifications[i];
            if (update.command === 'FETCH') {
                // skip multiple flag updates and updates for removed or newly added messages
                if (fetches.has(update.uid) || added.has(update.uid) || removed.has(update.uid)) {
                    this.selected.notifications.splice(i, 1);
                } else {
                    fetches.add(update.uid);
                }
            }
        }

        for (let i = 0, len = this.selected.notifications.length; i < len; i++) {
            let update = this.selected.notifications[i];

            // skip unnecessary entries that are already removed
            if (skip.has(update.uid)) {
                continue;
            }

            if (update.modseq > this.selected.modifyIndex) {
                this.selected.modifyIndex = update.modseq;
            }

            this._server.logger.info(
                {
                    tnx: 'notifications',
                    cid: this.id
                },
                '[%s] Processing notification: %s',
                this.id,
                JSON.stringify(update)
            );

            if (update.ignore === this.id) {
                continue; // skip this
            }

            this._server.logger.info(
                {
                    tnx: 'notifications',
                    cid: this.id
                },
                '[%s] UIDS: %s',
                this.id,
                this.selected.uidList.length
            );
            switch (update.command) {
                case 'EXISTS':
                    // Generate the response but do not send it yet (EXIST response generation is needed to modify the UID list)
                    // This way we can accumulate consecutive EXISTS responses into single one as
                    // only the last one actually matters to the client
                    existsResponse = this.formatResponse('EXISTS', update.uid);
                    changed = false;

                    break;

                case 'EXPUNGE': {
                    let seq = (this.selected.uidList || []).indexOf(update.uid);
                    this._server.logger.info(
                        {
                            tnx: 'expunge',
                            cid: this.id
                        },
                        '[%s] EXPUNGE %s',
                        this.id,
                        seq
                    );
                    if (seq >= 0) {
                        let output = this.formatResponse('EXPUNGE', update.uid);
                        this.writeStream.write(output);
                        changed = true; // if no more EXISTS after this, then generate an additional EXISTS
                    }

                    break;
                }
                case 'FETCH':
                    this.writeStream.write(
                        this.formatResponse('FETCH', update.uid, {
                            flags: update.flags,
                            modseq: (this.selected.condstoreEnabled && update.modseq) || false
                        })
                    );

                    break;
            }
        }

        if (existsResponse && !changed) {
            // send cached EXISTS response
            this.writeStream.write(existsResponse);
            existsResponse = false;
        }

        if (changed) {
            this.writeStream.write({
                tag: '*',
                command: String(this.selected.uidList.length),
                attributes: [
                    {
                        type: 'atom',
                        value: 'EXISTS'
                    }
                ]
            });
        }

        // clear queue
        this.selected.notifications = [];

        if (typeof this._server.onNotifications === 'function') {
            setImmediate(this._server.onNotifications.bind(this._server, this.selected.mailbox, this.selected.modifyIndex, this.session));
        }
    }

    formatResponse(command, uid, data) {
        command = command.toUpperCase();
        let seq;

        if (command === 'EXISTS') {
            this.selected.uidList.push(uid);
            seq = this.selected.uidList.length;
        } else {
            seq = (this.selected.uidList || []).indexOf(uid);
            if (seq < 0) {
                return false;
            }
            seq++;
        }

        if (command === 'EXPUNGE') {
            this.selected.uidList.splice(seq - 1, 1);
        }

        let response = {
            tag: '*',
            command: String(seq),
            attributes: [
                {
                    type: 'atom',
                    value: command
                }
            ]
        };

        if (data) {
            response.attributes.push([]);
            if ('query' in data) {
                // Response for FETCH command
                data.query.forEach((item, i) => {
                    response.attributes[1].push(item.original);
                    if (['flags', 'modseq'].indexOf(item.item) >= 0) {
                        response.attributes[1].push(
                            [].concat(data.values[i] || []).map(value => ({
                                type: 'ATOM',
                                value: (value || value === 0 ? value : '').toString()
                            }))
                        );
                    } else if (Object.prototype.toString.call(data.values[i]) === '[object Date]') {
                        response.attributes[1].push({
                            type: 'ATOM',
                            value: imapTools.formatInternalDate(data.values[i])
                        });
                    } else if (Array.isArray(data.values[i])) {
                        response.attributes[1].push(data.values[i]);
                    } else if (item.isLiteral) {
                        if (data.values[i] && data.values[i].type === 'stream') {
                            response.attributes[1].push({
                                type: 'LITERAL',
                                value: data.values[i].value,
                                expectedLength: data.values[i].expectedLength,
                                startFrom: data.values[i].startFrom,
                                maxLength: data.values[i].maxLength
                            });
                        } else {
                            response.attributes[1].push({
                                type: 'LITERAL',
                                value: data.values[i]
                            });
                        }
                    } else if (data.values[i] === '') {
                        response.attributes[1].push(data.values[i]);
                    } else {
                        response.attributes[1].push({
                            type: 'ATOM',
                            value: data.values[i].toString()
                        });
                    }
                });
            } else {
                // Notification response
                Object.keys(data).forEach(key => {
                    let value = data[key];
                    key = key.toUpperCase();
                    if (!value) {
                        return;
                    }

                    switch (key) {
                        case 'FLAGS':
                            value = [].concat(value || []).map(
                                flag =>
                                    flag && flag.value
                                        ? flag
                                        : {
                                            type: 'ATOM',
                                            value: flag
                                        }
                            );
                            break;

                        case 'UID':
                            value =
                                value && value.value
                                    ? value
                                    : {
                                        type: 'ATOM',
                                        value: (value || '0').toString()
                                    };
                            break;

                        case 'MODSEQ':
                            value = [].concat(
                                value && value.value
                                    ? value
                                    : {
                                        type: 'ATOM',
                                        value: (value || '0').toString()
                                    }
                            );
                            break;
                    }

                    response.attributes[1].push({
                        type: 'ATOM',
                        value: key
                    });

                    response.attributes[1].push(value);
                });
            }
        }

        return response;
    }
}

// Expose to the world
module.exports.IMAPConnection = IMAPConnection;
