'use strict';
// The curated Bitcoin ecosystem catalogue, for the dashboard's starter panel.
//
// Read-only and static, so unlike the rest of the dashboard API it does not
// require the dashboard key: a contributor who lands on a shared deployment
// can see which projects are covered before being asked for anything.
const { areaSummary, listProjects } = require('../src/bitcoin-ecosystem');
const { allowOptions, sendJson } = require('../src/http');

module.exports = async function handler(req, res) {
  if (allowOptions(req, res)) return;

  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const query = req.query || {};
  return sendJson(res, 200, {
    areas: areaSummary(),
    projects: listProjects({
      area: query.area || '',
      language: query.language || '',
      level: query.level || '',
    }),
  });
};
