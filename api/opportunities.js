'use strict';
const opportunities = require('../src/api/opportunities');
const opportunity = require('../src/api/opportunity');
const preferences = require('../src/api/preferences');

// The queue routes share one deployed function to fit Vercel's Hobby limit.
// vercel.json preserves their existing URLs and supplies the route parameters.
module.exports = function handler(req, res) {
  if (req.query?.__action === 'preferences') return preferences(req, res);
  if (req.query?.id) return opportunity(req, res);
  return opportunities(req, res);
};
