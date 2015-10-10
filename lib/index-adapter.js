var SSHAdapter = require('./ssh-adapter'),
  Promise = require('ember-cli/lib/ext/promise'),
  path = require('path'),
  exec = require('sync-exec'),
  chalk = require('chalk');

var green = chalk.green;
var blue = chalk.blue;

/**
 * Upload the `index.html` file contents
 *
 * @param  {IndexAdapter} adapter
 * @param  {String}       revisionDirectory
 * @param  {Buffer}       buffer
 * @return {Promise}
 */
function uploadIndex(adapter, revisionDirectory, buffer) {
  var location = path.join(revisionDirectory, 'index.html');

  return adapter.createFile(location, buffer).then(function() {
    adapter.ui.writeLine(green('File uploaded: \t' + location));
  });
}

/**
 * Upload the `metadata.json` file contents
 *
 * @param  {IndexAdapter} adapter
 * @param  {String}       revisionDirectory
 * @param  {Object}       metadata
 * @return {Promise}
 */
function uploadMetadata(adapter, revisionDirectory, metadata) {
  var location = path.join(revisionDirectory, 'metadata.json');

  return adapter.createFile(location, JSON.stringify(metadata)).then(function() {
    adapter.ui.writeLine(green('File uploaded: \t' + location));
  });
}

/**
 * Reads the directory via SFTP connection
 *
 * @param  {ssh2.SFTP} sftp
 * @param  {String}    directory
 * @return {Promise}
 */
function readDirectory(sftp, directory) {
  return new Promise(function(resolve, reject) {
    sftp.readdir(directory, function(err, list) {
      if (err) {
        reject(err);
      } else {
        resolve(list);
      }
    });
  });
}

/**
 * Reads a remote revison metadata information.
 *
 * Returns a Promise.
 *
 * @param  {ssh2.SFTP} sftp
 * @param  {String}    location
 * @param  {Object}    options
 * @return {Promise}
 */
function readRevisionMetadata(sftp, location, options) {
  return new Promise(function(resolve, reject) {
    sftp.readFile(location, options, function(error, data) {
      if (error) {
        reject(error);
      } else {
        var metadata = JSON.parse(data);

        resolve({
          filename: location,
          metadata: metadata,
        });
      }
    });
  });
}

/**
 * Fetch a List of all available revisions
 *
 * @param  {IndexAdapter} adapter
 * @return {Promise}
 */
function fetchRevisions(adapter) {
  var directory = adapter.config.remoteDir;

  return adapter.sftp().then(function(sftp) {
    return readDirectory(sftp, directory).then(function(files) {

      // Exclude the active revision `index.html` file
      return files.filter(function(file) {
        return file.filename !== 'index.html';
      });
    }).then(function(list) {
      var promises = list.map(function(file) {
        var revision = file.filename;
        var location = path.join(directory, revision, "metadata.json");

        return readRevisionMetadata(sftp, location);
      });

      return Promise.all(promises);
    });
  });
}

/**
 * Delete the old revisions from the Server
 *
 * @param  {IndexAdapter} adapter
 * @param  {Array}        revisions
 * @return {Promise}
 */
function deleteRevisions(adapter, revisions) {
  var revisionsToDelete = cleanupRevisions(adapter, revisions);

  return Promise.all(revisionsToDelete.map(function(revision) {
    var directory = path.dirname(revision);

    return adapter.deleteDirectory(directory);
  }));
}

/**
 * Removes the extra revisions from the Server.
 *
 * @param  {IndexAdapter} adapter
 * @param  {Array}        revisions
 * @return {Array}
 */
function cleanupRevisions(adapter, revisions) {
  var numerOfItemsToDelete = revisions.length - adapter.manifestSize;

  var sortedContents = sortRevisions(revisions);
  var itemsToDelete = sortedContents.slice((sortedContents.length - numerOfItemsToDelete)).map(function(item) {
    return item.filename;
  });

  return itemsToDelete;
}

/**
 * Sort the Revisions by Date, newest first.
 *
 * @param  {Array} revisions
 * @return {Array}
 */
function sortRevisions(revisions) {
  return revisions.sort(function(a, b) {
    return new Date(b.metadata.date) - new Date(a.metadata.date);
  });
}

/**
 * Print the Revision metadata information
 *
 * @param  {Array} revisions
 */
function printRevisions(adapter, revisions) {
  var header = green('Found the following revisions: \n');

  var revisionsList = revisions.reduce(function(prev, current, index) {
    var metadata = current.metadata;

    return prev + '\n\n' + (index + 1) + ') ' + metadata.revision + ' \n' +
      '\t Author:   \t' + blue(metadata.author) + ' \n' +
      '\t Date:     \t' + blue(metadata.date) + ' \n' +
      '\t Message:  \t' + blue(metadata.message) + ' \n' +
      '\t Filepath: \t' + blue(current.filename);
  }.bind(this), '');

  var footer = green('\n\nUse activate command to activate one of these revisions');
  var message = header + revisionsList + footer;

  adapter.ui.writeLine(message);
}

/**
 * Activate Revision
 *
 * @param  {IndexAdapter} adapter
 * @param  {ssh2.SFTP}    sftp
 * @param  {String}       revisions
 * @return {Promise}
 */
function activateRevision(adapter, sftp, revision) {
  var directory = adapter.config.remoteDir;

  var index = path.join(directory, 'index.html'),
    revisionIndex = path.join(directory, revision, 'index.html');

  return new Promise(function(resolve, reject) {
    sftp.unlink(index, function() {

      sftp.symlink(revisionIndex, index, function(err) {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  });
}

/**
 * SSH Adapter for revision managment.
 *
 * @class IndexAdapter
 * @extends SSHAdapter
 */
module.exports = SSHAdapter.extend({

  init: function() {
    this._super.apply(this, arguments);

    this.manifestSize = this.config.manifestSize || 10;
    this.indexMode = this.config.indexMode || 'direct';
  },

  /**
   * Upload the `index.html` File contents.
   *
   * @param  {Buffer} buffer
   * @return {Promise}
   */
  upload: function(buffer) {
    var metadata = this.generateMetadata(),
      adapter = this;

    return this.connect().then(function() {
      var directory = path.join(adapter.config.remoteDir, metadata.revision);

      return adapter.createDirectory(directory).then(function() {

        return Promise.all([
          uploadIndex(adapter, directory, buffer),
          uploadMetadata(adapter, directory, metadata)
        ]);

      });
    });
  },

  /**
   * List all revisions for this project.
   *
   * @return {Promise}
   */
  list: function() {
    var adapter = this;

    return fetchRevisions(adapter).then(sortRevisions).then(function(revisions) {
      printRevisions(adapter, revisions);

      // Delete older revisions
      return deleteRevisions(adapter, revisions).catch(function(error) {
        adapter.ui.write(chalk.yellow('\nError occured while deleting older revisions'));
        adapter.ui.writeLine(chalk.yellow(error.message));
      });

    }).catch(this.handleError('Could not List Revisions'));
  },

  /**
   * Activate the revision
   *
   * @return {Promise}
   */
  activate: function(revision) {
    var adapter = this;

    adapter.ui.startProgress(blue('Activating revision: \t' + revision, blue('.')));

    return fetchRevisions(adapter).then(function(revisions) {
      var revisionIds = revisions.map(function(revision) {
        return revision.metadata.revision;
      });

      if (revisionIds.indexOf(revision) > -1) {
        return adapter.sftp();
      } else {
        throw new Error('Revision `' + revision + '` doesn\'t exist');
      }
    }).then(function(sftp) {
      return activateRevision(adapter, sftp, revision);
    }).finally(function() {
      adapter.ui.stopProgress();
    }).then(function() {
      adapter.ui.writeLine(green('Revision `' + revision + '` has been been activated.'));
    }).catch(adapter.handleError('Could not activate revision `' + revision + '`.'));
  },

  /**
   * Generate the Metadata JSON Object for this revision.
   *
   * @return {Object}
   */
  generateMetadata: function() {
    var result = exec("git log -n 1 --pretty=format:'{%n  \"commit\": \"%H\",%n  \"author\": \"%an <%ae>\",%n  \"date\": \"%ad\",%n  \"message\": \"%f\"%n}'").stdout,
      revision = this.taggingAdapter.createTag();

    var metadata = JSON.parse(result);
    metadata.revision = revision;

    return metadata;
  }
});
