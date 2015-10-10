/* jshint node: true */
'use strict';
var Indexdapter = require('./lib/index-adapter');
var AssetsAdapter = require('./lib/assets-adapter');

module.exports = {
	name: 'ember-cli-deploy-ssh',
	type: 'ember-deploy-addon',
	adapters: {
		index: {
			'ssh': Indexdapter
		},

		assets: {
			'ssh': AssetsAdapter
		}
	}
};
