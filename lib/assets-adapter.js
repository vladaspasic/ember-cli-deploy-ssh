var SSHAdapter = require('./ssh-adapter'),
  Promise = require('ember-cli/lib/ext/promise'),
  readdir = require('readdir'),
  path = require('path'),
  fs = require('fs'),
  chalk = require('chalk');

var green = chalk.green;
var blue = chalk.blue;

/**
 * List all the assets file locations that should be uploaded.
 *
 * @param  {AssetsAdapter} adapter
 * @return {Promise}
 */
function listAssets(adapter) {
  var directory = adapter.buildPath;

  return new Promise(function(resolve, reject) {
    readdir.read(directory, ['assets/**.*'], function(error, files) {
      if (error) {
        return reject(error);
      }

      files = files.filter(function(file) {
        return file.indexOf('test-') < 0;
      });

      return resolve(files);
    });
  });
}

/**
 * Read the contents of the file as a Buffer.
 *
 * @param  {AssetsAdapter} adapter
 * @param  {String}        file
 * @return {RSVP.Promise}
 */
function readFileContents(adapter, file) {
  var location = path.join(adapter.buildPath, file);
  adapter.debug('Reading file contents ' + location);

  return new Promise(function(resolve, reject) {
    fs.readFile(location, function(error, buffer) {
      if (error) {
        return reject(error);
      }

      return resolve({
        name: file,
        location: location,
        buffer: buffer
      });
    });
  });
}

/**
 * Upload the Asset to the server.
 *
 * @param  {AssetsAdapter} adapter
 * @param  {String}        location
 * @return {Promise}
 */
function uploadAsset(adapter, location) {
  return readFileContents(adapter, location).then(function(file) {
    var uploadLocation = path.join(adapter.config.remoteDir, file.name);

    adapter.ui.pleasantProgress.start(blue('Uploading asset: \t' + file.name), blue('.'));

    // adapter.sftp().then(function(sftp) {
    //   sftp.fastPut(file.location, uploadLocation, function() {
    //     console.log('OK', arguments);
    //   });
    // });

    return adapter.createFile(uploadLocation, file.buffer).finally(function() {
      adapter.ui.stopProgress();
      adapter.ui.writeLine('File uploaded: \t' + green(file.name) + '\n');
    }, function() {
      adapter.ui.stopProgress();
      adapter.ui.writeLine('Could not upload: \t' + chalk.red(file.name) + '\n');
    });
  });
}

/**
 * SSH Adapter for assets managment.
 *
 * @class AssetsAdapter
 * @extends SSHAdapter
 */
module.exports = SSHAdapter.extend({
  init: function() {
    this._super.apply(this, arguments);

    this.buildPath = this.config.buildPath;
    this.config = this.config.assets;
  },

  upload: function() {
    var adapter = this;

    this.ui.pleasantProgress.start(blue('Uploading assets'), blue('.'));

    return listAssets(this).then(function(assets) {
      var promise = Promise.resolve();

      assets.forEach(function(asset) {
        promise = promise.then(function() {
          return uploadAsset(adapter, asset);
        });
      });

      return promise;
    }).finally(function() {
      adapter.ui.stopProgress();
    }).then(function() {
      adapter.ui.writeLine(green('All assets have been uploaded.'));
    }).catch(adapter.handleError('Error occurred while uploading assets.'));
  }

});
