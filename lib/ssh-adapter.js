'use strict';
var CoreObject = require('core-object');
var path = require('path');
var Promise = require('ember-cli/lib/ext/promise');
var SilentError = require('silent-error');
var chalk = require('chalk');
var ssh2 = require('ssh2');

/**
 * Connects to the given ssh2.Client instance.
 *
 * Wraps the connection into a Promise.
 *
 * @param  {ssh2.Client} client
 * @param  {Object}      config
 * @return {Promise}
 */
function connect(client, config) {
  var ssh_config = {
    host: config.host,
    username: config.username,
    port: config.port || '22',
    agent: config.agent,
    passphrase: config.passphrase
  };

  if (typeof config.privateKeyFile !== 'undefined') {
    ssh_config['privateKey'] = require('fs').readFileSync(config.privateKeyFile);
  }

  return new Promise(function(resolve, reject) {
    client.on('ready', function() {
      resolve(client);
    });

    client.on('error', function(error) {
      reject(error);
    });

    client.connect(ssh_config);
  });
}

/**
 * Creates an SFTP connection and wraps it in a Promise.
 *
 * @param  {ssh2.Connect} client
 * @return {Promise}
 */
function sftp(client) {
  return new Promise(function(resolve, reject) {

    client.sftp(function(error, sftp) {
      if (error) {
        reject(error);
      } else {
        resolve(sftp);
      }
    });

  });
}

/**
 * Executes a command on the remote server.
 *
 * @param  {ssh2.Client} connection
 * @param  {String}      command
 * @return {Promise}
 */
function execCommand(connection, command) {
  return new Promise(function(resolve, reject) {
    connection.exec(command, function(error, stream) {
      if (error) {
        reject(error);
        return;
      }

      stream.on('error', reject);
      stream.on('close', function(code) {
        if (typeof code !== 'number') {
          return resolve(code);
        }

        if (code === 0) {
          resolve(code);
        } else {
          reject(new Error('Command `' + command + '` exited with code: ' + code));
        }
      });
    });
  });
}

/**
 * Creates a new directory on the destination Server.
 *
 * @param  {ssh2.Client} connection
 * @param  {String}      location
 * @return {Promise}
 */
function createDirectory(connection, location) {
  return execCommand(connection, 'mkdir -p ' + location);
}

/**
 * Deletes a directory on the destination Server.
 *
 * @param  {ssh2.Client} connection
 * @param  {String}      location
 * @return {Promise}
 */
function deleteDirectory(connection, location) {
  return execCommand(connection, 'rm -rf ' + location);
}

/**
 * Uploads a new file to the Server.
 *
 * @param  {ssh2.SFTP} sftp
 * @param  {String}    location
 * @param  {Buffer}    buffer
 * @return {Promise}
 */
function uploadFile(sftp, location, buffer) {
  return new Promise(function(resolve, reject) {
    var stream = sftp.createWriteStream(location);

    stream.on('error', reject);
    stream.on('end', reject);
    stream.on('close', resolve);

    stream.write(buffer);
    stream.end();
  });
}

/**
 * Base SSH based Adapter used to upload the Assets and the `index.html` file.
 *
 * @class SSHAdapter
 */
module.exports = CoreObject.extend({
  init: function() {
    CoreObject.prototype.init.apply(this, arguments);

    if (!this.config) {
      throw new SilentError('You must supply a config');
    }

    this.client = new ssh2.Client();
    this._connected = false;
  },

  /**
   * Connect to an server via SSH Client. If a connection is still
   * open, it would not attempt to create another one.
   *
   * @return {Promise}
   */
  connect: function() {
    if (this._connected) {
      return Promise.resolve(this.client);
    }

    var adapter = this;

    this.client.once('close', function() {
      adapter._connected = false;
      adapter.debug('SSH Connection closed.');
    });

    return connect(this.client, this.config).then(function(client) {
      adapter._connected = true;
      adapter.debug('New SSH Connection created.');

      return client;
    });
  },

  /**
   * Open an SFTP Connection to the server.
   *
   * @return {Promise}
   */
  sftp: function() {
    if (this._sftp) {
      return Promise.resolve(this._sftp);
    }

    var adapter = this;

    return this.connect().then(function(client) {
      return sftp(client);
    }).then(function(sftp) {
      adapter._sftp = sftp;

      adapter.debug('New SFTP Connection created.');

      sftp.once('close', function() {
        adapter._sftp = null;

        adapter.debug('SFTP Connection closed.');
      });

      return sftp;
    });
  },

  /**
   * Create a new Directory
   *
   * @param  {String} location
   * @return {Promise}
   */
  createDirectory: function(location) {
    if (typeof location !== 'string' || location.length === 0) {
      throw new TypeError('Directory location must be a String and it can not be empty.');
    }

    return this.connect().then(function(connection) {
      return createDirectory(connection, location);
    }).catch(this.handleError('Could not create directory ' + location));
  },

  /**
   * Delete a Directory
   *
   * @param  {String} location
   * @return {Promise}
   */
  deleteDirectory: function(location) {
    if (typeof location !== 'string' || location.length === 0) {
      throw new TypeError('Directory location must be a String and it can not be empty.');
    }

    return this.connect().then(function(connection) {
      return deleteDirectory(connection, location);
    }).catch(this.handleError('Could not delete directory ' + location));
  },

  /**
   * Create a new File and missing directories
   *
   * @param  {String} location
   * @param  {Buffer} buffer
   * @return {Promise}
   */
  createFile: function(location, buffer) {
    if (typeof location !== 'string' || location.length === 0) {
      throw new TypeError('File location must be a String and it can not be empty.');
    }

    var filename = path.basename(location),
      dirname = path.dirname(location),
      adapter = this;

    adapter.debug('Uploading file: \t' + filename + '\t');

    return this.createDirectory(dirname).then(function() {
      return adapter.sftp().then(function(sftp) {
        return uploadFile(sftp, location, buffer);
      });
    }).catch(adapter.handleError('Could not upload file ' + filename));
  },

  /**
   * Write a debug level message
   *
   * @param  {String} message
   */
  debug: function(message) {
    var debug = this.ui.WRITE_LEVELS.DEBUG;
    this.ui.writeLine(chalk.blue(message), debug);
  },

  /**
   * Creates a Promise Error handler by throwing
   * a SilentError with an added error message.
   *
   * @param  {String} message
   * @return {Function}
   */
  handleError: function(message) {
    var adapter = this;

    return function(error) {
      adapter.client.end();

      var errorMessage = '\n' + message + '\n' + (error.stack || error.message || error);
      throw new SilentError(errorMessage);
    };
  }
});
