/**
 * API to get a form for particular version
 */
import validate from 'express-validation';
import Joi from 'joi';
import { middleware as tcMiddleware } from 'tc-core-library-js';

import util from '../../../util';
import models from '../../../models';


const permissions = tcMiddleware.permissions;

const schema = {
  params: {
    key: Joi.string().max(45).required(),
    version: Joi.number().integer().positive().required(),
  },
};

module.exports = [
  validate(schema),
  permissions('form.view'),
  (req, res, next) => {
    util.fetchByIdFromES('forms', {
      query: {
        nested: {
          path: 'forms',
          query: {
            filtered: {
              filter: {
                bool: {
                  must: [
                    { term: { 'forms.key': req.params.key } },
                    { term: { 'forms.version': req.params.version } },
                  ],
                },
              },
            },
          },
          inner_hits: {},
        },
      },
      sort: { 'forms.revision': 'desc' },
    }, 'metadata')
    .then((data) => {
      if (data.length === 0) {
        req.log.debug('No form found in ES');
        return models.Form.findOneWithLatestRevision(req.params)
          .then((form) => {
            // Not found
            if (!form) {
              const apiErr = new Error(`Form not found for key ${req.params.key} version ${req.params.version}`);
              apiErr.status = 404;
              return Promise.reject(apiErr);
            }
            res.json(form);
            return Promise.resolve();
          })
          .catch(next);
      }
      req.log.debug('forms found in ES');
      res.json(data[0].inner_hits.forms.hits.hits[0]._source); // eslint-disable-line no-underscore-dangle
      return Promise.resolve();
    })
    .catch(next);
  },
];
