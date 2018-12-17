'use strict';

const errs = require('restify-errors');
const Ajv = require('ajv');
const logger = require('lambda-log');
const ajv = new Ajv({ allErrors: true, removeAdditional: true, errorDataPath: 'property', useDefaults: true, coerceTypes: true, format: 'full' });

let callbackWaitsForEmptyEventLoop = true;
let autoClean = false;
let DB;

module.exports.logger = logger;
module.exports.errs = errs;
module.exports.ajv = ajv;

module.exports.configure = (config) => {
    if ('debug' in config) logger.options.debug = config.debug;
    if ('callbackWaitsForEmptyEventLoop' in config) callbackWaitsForEmptyEventLoop = config.callbackWaitsForEmptyEventLoop;
    if ('autoClean' in config) autoClean = config.autoClean;
    if ('DB' in config) DB = config.DB;

    logger.debug('Handler - Global configuration done');
};


module.exports.sqs = ({ handler, workflow = 'parallel' }) => {
    logger.debug('Handler - Initialize sqs');
    
    if (['parallel', 'series', 'series-stopfail'].includes(workflow)) workflow = 'parallel';

    return async ({ Records }, context) => {
        if (!Records.length) return;
        if (callbackWaitsForEmptyEventLoop === false) context.callbackWaitsForEmptyEventLoop = false;

        let hasErrors = false;
        if (workflow === 'parallel') {
            await Promise.all(Records.map(i => {
                if (i.eventSource !== 'aws:sqs') return;
                return handler(i).catch((err) => { logger.error(err); hasErrors = true; });
            }));
        } else {
            for (const record of Records) {
                if (record.eventSource !== 'aws:sqs') continue;
                handler(record).catch((err) => {
                    logger.error(err);
                    hasErrors = true;
                    if (workflow === 'series-stopfail') throw new Error('some_records_failed');
                });
            }
        }
        
        if (hasErrors) throw new Error('some_records_failed');
    };
};

module.exports.api = ({ routes, prehandler }) => {
    logger.debug('Handler - Initialize api');

    for (const audience in routes) {
        for (const route in routes[audience]) {
            const routeConfig = routes[audience][route];
            if (routeConfig.params) {
                routeConfig.params.$async = true; // force
                routeConfig.params = ajv.compile(routeConfig.params);
            }
            if (routeConfig.headers) {
                routeConfig.headers.$async = true; // force
                routeConfig.headers = ajv.compile(routeConfig.headers);
            }
            if (routeConfig.query) {
                routeConfig.query.$async = true; // force
                routeConfig.query = ajv.compile(routeConfig.query);
            }
            if (routeConfig.body) {
                routeConfig.body.$async = true; // force
                routeConfig.body = ajv.compile(routeConfig.body);
            }
        }
    }


    return async (event, context) => {
        if (callbackWaitsForEmptyEventLoop === false) context.callbackWaitsForEmptyEventLoop = false;

        let source;

        const res = (data = null, statusCode = 200) => {
            if (source === 'api') return {
                isBase64Encoded: false,
                statusCode: statusCode === 200 && !data ? 204 : statusCode,
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
                body: data ? JSON.stringify(data) : null
            };

            return { status: statusCode === 200 && !data ? 204 : statusCode, body: data };
        };

        try {

            if (event.requestContext) { // api gateway
                event.method = event.httpMethod;
                event.query = event.queryStringParameters;
                event.params = event.pathParameters;
                event.audience = event.stageVariables ? event.stageVariables.audience : null;
                event.authorizer = event.requestContext.authorizer || {};
                source = 'api';
            } else {
                source = 'direct';
            }

            if (!event.authorizer) event.authorizer = {};

            if (!event.audience) throw new errs.ForbiddenError();

            const pathCompute = `${event.resource} [${event.method}]`;

            logger.debug('Handler - Check path', pathCompute);
            const mod = routes[event.audience][pathCompute];
            if (!mod) throw new errs.ForbiddenError();

            if (!event.headers) event.headers = {};
            if (!event.query) event.query = {};
            if (!event.params) event.params = {};

            logger.debug('Handler - Parse body');
            if (event.body && source === 'api') {
                try {
                    event.body = JSON.parse(event.body);
                } catch (e) {
                    throw new errs.BadRequestError('invalid_payload');
                }
            } else if (!event.body) event.body = {};
            
            if(mod.clean || autoClean) {
                logger.debug('Handler - Clean body');
                event.body = removeEmpty(event.body);
            }

            if (mod.params) {
                logger.debug('Handler - Validate params');
                await mod.params(event.params);
            }

            if (mod.headers) {
                logger.debug('Handler - Validate headers');
                await mod.headers(event.headers);
            }

            if (mod.query) {
                logger.debug('Handler - Validate query');
                await mod.query(event.query);
            }

            if (mod.body) {
                logger.debug('Handler - Validate body');
                await mod.body(event.body);
            }

            let db;
            if (DB) {
                logger.debug('Handler - Get the database connection');
                db = await DB({ logger });
            }
            event.meta = mod.meta || {};
            
            const tools = {
                logger,
                DB: db,
                errs,
            };

            if (prehandler) await prehandler(event, tools);

            logger.debug('Handler - Execute');
            const output = await mod.handler(event, tools);
            
            logger.debug('Handler - Output', mod.status);
            return res(output, mod.status ? mod.status : (output ? 200 : 204));

        } catch (err) {
            return handlerError(err, res, logger);
        }
    };
};

function handlerError(err, res, logger) {
    if (err instanceof Ajv.ValidationError || err.ajv === true) return res({
        status: 400,
        errors: parseAjvErrors(err.errors)
    }, 400);
    
    if (err.name && err.name === 'SequelizeValidationError') {
        logger.error('sequelize', err);
        return res({
            status: 500,
            error: 'internal_error',
        }, 500);
    } 

    if (err.name === 'BadRequestError') {
        const info = errs.info(err);
        
        if (info) {
            if (info.ajv) return res({
                status: 400,
                errors: parseAjvErrors(info && info.ajv.errors),
                type: info.type || undefined,
            }, 400);

            if (info.path) return res({
                status: 400,
                type: info.type || undefined,
                errors: [{ 
                    path: info && info.path, 
                    error: info && info.code 
                }]
            }, 400);
                
            if ( info && info.message) return res({
                status: 400,
                type: info.type || undefined,
                message: info && info.message,
            }, 400);
                
            if ( info && info.errors) return res({
                status: 400,
                type: info.type || undefined,
                errors: info.errors,
            }, 400);
                
            if ( info && info.output) return res({
                status: 400,
                type: info.type || undefined,
                ...info.output,
            }, 400);
        }
            
        return res({
            status: 400,
            error: err.message || 'invalid',
        }, 400);
    }

    if (err.name === 'ForbiddenError') return res({
        status: 403,
        error: err.message || 'forbidden',
    }, 403);
    
    if (err.name === 'NotFoundError') return res({
        status: 404,
        error: err.message || 'not_found',
    }, 404);
    

    if (err.name === 'PayloadTooLargeError') return res({
        status: 413,
        error: err.message || 'payload_too_large',
    }, 413);

    if (err.name === 'ConflictError') return res({
        status: 409,
        error: err.message || 'duplicate',
    }, 409);
    
    if (err.name === 'UnauthorizedError') return res({
        status: 401,
        error: 'unauthorized',
    }, 401);
    
    if (err.name === 'MethodNotAllowedError') return res({
        status: 405,
        error: 'method_not_allowed',
    }, 405);
    
    if (err.name === 'TooManyRequestsError') return res({
        status: 429,
        error: 'throttled',
    }, 429);

    if (err.name === 'InternalServerError') return res({
        status: 500,
        error: 'internal',
    }, 500);
    
    // handle aws throttling errors
    if (err.code === 'TooManyRequestsException' || err.code === 'ThrottlingException') return res({
        status: 429,
        error: 'throttled',
    }, 429);

    logger.error(err); // no need to try catch

    return res({
        status: 500,
        error: 'internal_error',
    }, 500);
}

function parseAjvErrors(errors, pathPrefix) {
    return errors.map((errorData) => {
        if (errorData.dataPath.startsWith('[\'')) errorData.dataPath = errorData.dataPath.substring(2);
        if (errorData.dataPath.endsWith('\']')) errorData.dataPath = errorData.dataPath.substring(0, errorData.dataPath.length - 2);
        if (errorData.dataPath.startsWith('.')) errorData.dataPath = errorData.dataPath.substring(1);

        return {
            path: `${pathPrefix || ''}${errorData.dataPath}`,
            // message: error.message,
            error: errorData.keyword === 'enum' ? 'invalid': errorData.keyword,
            limit: errorData.params ? (errorData.params.limit || undefined) : undefined,
            format: errorData.params ? (errorData.params.format || undefined) : undefined,
            type: errorData.params ? (errorData.params.type || undefined) : undefined,
            pattern: errorData.params ? (errorData.params.pattern || undefined) : undefined,
            required: errorData.params ? (errorData.params.required || undefined) : undefined,
            minimum: errorData.params ? (errorData.params.minimum || undefined) : undefined,
            maximum: errorData.params ? (errorData.params.maximum || undefined) : undefined,
        };
    });
}

function removeEmpty(obj) {
    return Object.keys(obj).filter(k => obj[k] !== null && obj[k] !== undefined).reduce((newObj, k) => {
        if (typeof obj[k] === 'object' && !Array.isArray(obj[k])) return Object.assign(newObj, {[k]: removeEmpty(obj[k])});
        return Object.assign(newObj, {[k]: obj[k]});
    }, {});
}
