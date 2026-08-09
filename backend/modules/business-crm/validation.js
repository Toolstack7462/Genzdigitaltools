'use strict';

const Joi = require('joi');
const id = Joi.string().guid({ version: ['uuidv4', 'uuidv5'] });
const nullableId = id.allow(null, '');
const currency = Joi.string().uppercase().valid('PKR', 'INR', 'NGN');
const money = Joi.string().pattern(/^\d+(?:\.\d{1,2})?$/).max(21);
const date = Joi.date().iso().raw();
const version = Joi.number().integer().min(1);
const contact = {
  name: Joi.string().trim().min(1).max(190).required(), whatsapp: Joi.string().trim().max(40).allow('', null),
  email: Joi.string().email({ tlds: { allow: false } }).max(190).allow('', null), company: Joi.string().trim().max(190).allow('', null),
  address: Joi.string().trim().max(2000).allow('', null), taxId: Joi.string().trim().max(80).allow('', null),
  notes: Joi.string().trim().max(5000).allow('', null), status: Joi.string().valid('active', 'inactive').default('active'),
};
const item = Joi.object({
  id: nullableId, productId: nullableId, name: Joi.string().trim().min(1).max(190).required(),
  accountType: Joi.string().valid('private', 'shared', 'service', 'other').default('private'), durationLabel: Joi.string().trim().max(80).allow('', null),
  purchaseDate: date.allow(null, ''), expiryDate: date.allow(null, ''), credentialEmail: Joi.string().max(500).allow('', null),
  credentialPassword: Joi.string().max(1000).allow('', null), keepCredentialEmail: Joi.boolean().default(false), keepCredentialPassword: Joi.boolean().default(false),
  salePrice: money.required(), purchaseCost: money.default('0.00'),
});
const productShape = {
  name: Joi.string().trim().min(1).max(190).required(), category: Joi.string().trim().min(1).max(100).default('Software'),
  accountType: Joi.string().valid('private', 'shared', 'service', 'other').default('private'), durationLabel: Joi.string().trim().max(80).allow('', null),
  defaultSalePrice: money.default('0.00'), defaultPurchaseCost: money.default('0.00'), currencyCode: currency.required(),
  active: Joi.boolean().default(true), notes: Joi.string().max(5000).allow('', null),
};
const schemas = {
  clientCreate: Joi.object(contact), clientUpdate: Joi.object({ ...contact, version: version.required() }),
  vendorCreate: Joi.object(contact), vendorUpdate: Joi.object({ ...contact, version: version.required() }),
  productCreate: Joi.object(productShape), productUpdate: Joi.object({ ...productShape, version: version.required() }),
  saleCreate: Joi.object({
    clientId: id.required(), vendorId: nullableId, saleDate: date.required(), orderType: Joi.string().valid('new', 'renewal').default('new'),
    currencyCode: currency.required(), notes: Joi.string().max(10000).allow('', null), invoiceInstructions: Joi.string().max(10000).allow('', null),
    items: Joi.array().items(item).min(1).max(20).required(), openingClientPayment: money.default('0.00'), openingVendorPayment: money.default('0.00'),
    paymentMethod: Joi.string().max(40).allow('', null), idempotencyKey: Joi.string().max(128).allow('', null),
  }),
  saleUpdate: Joi.object({
    clientId: id.required(), vendorId: nullableId, saleDate: date.required(), orderType: Joi.string().valid('new', 'renewal').required(),
    currencyCode: currency.required(), notes: Joi.string().max(10000).allow('', null), invoiceInstructions: Joi.string().max(10000).allow('', null),
    items: Joi.array().items(item).min(1).max(20).required(), version: version.required(),
  }),
  payment: Joi.object({
    partyType: Joi.string().valid('client', 'vendor').required(), amount: money.required(), paymentDate: date.required(), method: Joi.string().max(40).allow('', null),
    reference: Joi.string().max(190).allow('', null), notes: Joi.string().max(5000).allow('', null), idempotencyKey: Joi.string().max(128).allow('', null),
  }),
  expenseCreate: Joi.object({
    expenseDate: date.required(), category: Joi.string().trim().min(1).max(80).required(), description: Joi.string().trim().min(1).max(255).required(),
    payee: Joi.string().max(190).allow('', null), amount: money.required(), currencyCode: currency.required(), method: Joi.string().max(40).allow('', null),
    reference: Joi.string().max(190).allow('', null), notes: Joi.string().max(5000).allow('', null), idempotencyKey: Joi.string().max(128).allow('', null),
  }),
  expenseUpdate: Joi.object({
    expenseDate: date.required(), category: Joi.string().trim().min(1).max(80).required(), description: Joi.string().trim().min(1).max(255).required(),
    payee: Joi.string().max(190).allow('', null), amount: money.required(), currencyCode: currency.required(), method: Joi.string().max(40).allow('', null),
    reference: Joi.string().max(190).allow('', null), notes: Joi.string().max(5000).allow('', null), version: version.required(),
  }),
  task: Joi.object({
    title: Joi.string().trim().min(1).max(220).required(), description: Joi.string().max(10000).allow('', null),
    priority: Joi.string().valid('low', 'normal', 'high', 'urgent').default('normal'), status: Joi.string().valid('open', 'in_progress', 'completed', 'cancelled').default('open'),
    dueAt: Joi.date().iso().raw().allow('', null), assignedUserId: Joi.string().max(64).allow('', null), clientId: nullableId, vendorId: nullableId, saleId: nullableId,
    version: version.optional(),
  }),
  activity: Joi.object({
    entityType: Joi.string().valid('client', 'vendor', 'sale').required(), entityId: id.required(),
    activityType: Joi.string().valid('note', 'call', 'email', 'meeting', 'reminder').required(), subject: Joi.string().max(220).allow('', null), body: Joi.string().max(10000).allow('', null),
  }),
  settings: Joi.object({
    storeName: Joi.string().min(1).max(160).required(), storeEmail: Joi.string().email({ tlds: { allow: false } }).max(190).allow('', null),
    storePhone: Joi.string().max(40).allow('', null), storeAddress: Joi.string().max(3000).allow('', null), invoicePrefix: Joi.string().uppercase().pattern(/^[A-Z0-9-]{1,16}$/).required(),
    defaultCurrency: currency.required(), whatsappCountryCode: Joi.string().pattern(/^\d{1,8}$/).required(), invoiceTerms: Joi.string().max(10000).allow('', null),
    logoUrl: Joi.string().uri({ allowRelative: true }).max(500).allow('', null), includeCredentialsInInvoice: Joi.boolean().default(false), includeCredentialsInMessages: Joi.boolean().default(false),
  }),
  access: Joi.object({
    businessRole: Joi.string().valid('OWNER', 'ADMIN', 'MANAGER', 'STAFF', 'VIEWER').required(), active: Joi.boolean().default(true),
    overrides: Joi.array().items(Joi.object({ permission: Joi.string().max(80).required(), effect: Joi.string().valid('allow', 'deny').required() })).max(100).default([]),
  }),
};
function validate(schemaName) {
  return (req, res, next) => {
    const schema = schemas[schemaName];
    if (!schema) return next(new Error(`Unknown validation schema ${schemaName}`));
    const { value, error } = schema.validate(req.body, { abortEarly: false, stripUnknown: true, convert: true });
    if (error) return res.status(400).json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: error.details.map((detail) => ({ path: detail.path.join('.'), message: detail.message })) });
    req.validated = value;
    return next();
  };
}
module.exports = { schemas, validate };
