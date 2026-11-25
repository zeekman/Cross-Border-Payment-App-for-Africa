/**
 * Derives an OpenAPI 3.1 JSON Schema object from a single declarative field
 * spec, and express-validator chains from the same spec.
 *
 * This exists so Swagger/OpenAPI docs and runtime request validation share
 * ONE definition per field instead of two hand-maintained copies that can
 * silently drift apart (see issue: Swagger docs should be generated from the
 * same validators used at runtime).
 *
 * A "field spec" looks like:
 *   {
 *     name: 'amount',
 *     in: 'body',            // 'body' | 'query'
 *     type: 'number',        // openapi type
 *     required: true,
 *     description: 'Amount must be greater than 0',
 *     enum: ['XLM', 'USDC'], // optional
 *     format: 'float',       // optional
 *     custom: (value, meta) => true, // optional express-validator .custom()
 *     errorMessage: 'Amount must be greater than 0', // optional
 * }
 */
const { body, query } = require('express-validator');

function buildValidatorChain(field) {
  const locator = field.in === 'query' ? query : body;
  let chain = locator(field.name);

  if (field.required) {
    chain = chain.notEmpty().withMessage(field.errorMessage || `${field.name} is required`);
  } else {
    chain = chain.optional();
  }

  if (field.type === 'number') {
    chain = chain.isFloat(field.floatOptions || {}).withMessage(field.errorMessage || `${field.name} must be a number`);
  } else if (field.type === 'integer') {
    chain = chain.isInt(field.intOptions || {}).withMessage(field.errorMessage || `${field.name} must be an integer`);
  } else if (field.type === 'string' && field.trim) {
    chain = chain.trim();
  }

  if (field.enum) {
    chain = chain.isIn(field.enum).withMessage(field.errorMessage || `${field.name} must be one of ${field.enum.join(', ')}`);
  }

  if (field.custom) {
    chain = chain.custom(field.custom);
    if (field.errorMessage) chain = chain.withMessage(field.errorMessage);
  }

  return chain;
}

/**
 * Build the express-validator chain array used by the route (runtime).
 */
function validatorsFromSpec(fields) {
  return fields.map(buildValidatorChain);
}

/**
 * Build the OpenAPI 3.1 schema object for the request body used by the
 * Swagger docs (docs), derived from the exact same field specs.
 */
function openApiSchemaFromSpec(fields, { title } = {}) {
  const properties = {};
  const required = [];

  fields
    .filter((f) => f.in !== 'query')
    .forEach((f) => {
      const prop = { type: f.type, description: f.description };
      if (f.enum) prop.enum = f.enum;
      if (f.format) prop.format = f.format;
      properties[f.name] = prop;
      if (f.required) required.push(f.name);
    });

  const schema = { type: 'object', properties };
  if (title) schema.title = title;
  if (required.length) schema.required = required;
  return schema;
}

module.exports = { validatorsFromSpec, openApiSchemaFromSpec };
