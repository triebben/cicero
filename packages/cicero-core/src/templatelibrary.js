/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const NodeCache = require('node-cache');
const Template = require('./template');
const Logger = require('@accordproject/ergo-compiler').Logger;
const rp = require('request-promise-native');
const crypto = require('crypto');
const stringify = require('json-stable-stringify');
const semver = require('semver');

const globalTemplateCache = new NodeCache({ stdTTL: 600, useClones: false });
const globalTemplateIndexCache = new NodeCache({ stdTTL: 600, useClones: false });

/**
 * <p>
 * Loads templates from the Accord Project Template Library
 * stored at: https://templates.accordproject.org. The template index
 * and the templates themselves are cached in a global in-memory cache with a TTL
 * of 600 seconds. Call the clearCache method to clear the cache.
 * </p>
 * @private
 * @class
 */
class TemplateLibrary {
    /**
     * Create the Template Library
     * @param {string} url - the url to connect to. Defaults to
     * https://templates.accordproject.org
     * @param {object} auth - authentication object
     * @param {object} auth.type - HTTP Auth type
     * @param {object} auth.credential - HTTP Auth credential base64 encoded
     */
    constructor(url=null, auth=null) {
        this.url = url || 'https://templates.accordproject.org';
        this.auth = auth;
        // Logging
        Logger.info('Creating TemplateLibrary for ' + this.url);
        if (this.auth && this.auth.type && this.auth.credential){
            Logger.info('TemplateLibrary with authentication');
        } else {
            Logger.info('TemplateLibrary without authentication');
        }
    }

    /**
     * Clears the caches
     */
    async clearCache() {
        globalTemplateCache.flushAll();
        globalTemplateIndexCache.flushAll();
    }

    /**
     * Returns a template index that only contains the latest version
     * of each template
     *
     * @param {object} templateIndex - the template index
     * @returns {object} a new template index that only contains the latest version of each template
     */
    static filterTemplateIndexLatestVersion(templateIndex) {
        const result = {};
        const nameToVersion = {};

        // build a map of the latest version of each template
        for(let template of Object.keys(templateIndex)) {
            const atIndex = template.indexOf('@');
            const name = template.substring(0,atIndex);
            const version  = template.substring(atIndex+1);

            const existingVersion = nameToVersion[name];

            if(!existingVersion || semver.lt(existingVersion, version)) {
                nameToVersion[name] = version;
            }
        }

        // now build the result
        for(let name in nameToVersion) {
            const id = `${name}@${nameToVersion[name]}`;
            result[id] = templateIndex[id];
        }

        return result;
    }

    /**
     * Returns a template index that only contains the latest version
     * of each template
     *
     * @param {object} templateIndex - the template index
     * @param {string} ciceroVersion - the cicero version in semver format
     * @returns {object} a new template index that only contains the templates that are semver compatible
     * with the cicero version specified
     */
    static filterTemplateIndexCiceroVersion(templateIndex, ciceroVersion) {
        const result = {};

        // build a map of the templates that are compatible with the cicero version
        for(let key of Object.keys(templateIndex)) {
            const template = templateIndex[key];

            if(semver.satisfies(ciceroVersion, template.ciceroVersion, { includePrerelease: true })) {
                result[key] = template;
            }
        }

        return result;
    }

    /**
     * Gets the metadata for all the templates in the template library
     * @param {object} [options] - the (optional) options
     * @param {object} [options.latestVersion] - only return the latest version of each template
     * @param {object} [options.ciceroVersion] - semver filter on the cicero engine version. E.g. pass 0.4.6 to
     * only return templates that are compatible with Cicero version 0.4.6
     * @return {Promise} promise to a template index
     */
    async getTemplateIndex(options) {
        const cacheKey = this.getTemplateIndexCacheKey(options);
        const result = globalTemplateIndexCache.get(cacheKey);
        if (result) {
            Logger.info('Returning template index from cache');
            return Promise.resolve(result);
        }

        const httpOptions = {
            uri: `${this.url}/template-library.json`,
            headers: {
                'User-Agent': 'clause',
            },
            json: true, // Automatically parses the JSON string in the response
        };
        // Set HTTP auth if available
        // https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Authorization
        if (this.auth && this.auth.type && this.auth.credential){
            // httpOptions.headers.Authorization = this.auth.type + ' ' + this.auth.credential;
            httpOptions.headers.Authorization = this.auth.type + ' ' + this.auth.credential;
        }
        Logger.info('Loading template library from', httpOptions.uri);
        return rp(httpOptions)
            .then((templateIndex) => {

                if(options && options.latestVersion) {
                    templateIndex = TemplateLibrary.filterTemplateIndexLatestVersion(templateIndex);
                }

                if(options && options.ciceroVersion) {
                    templateIndex = TemplateLibrary.filterTemplateIndexCiceroVersion(templateIndex, options.ciceroVersion);
                }

                globalTemplateIndexCache.set(cacheKey, templateIndex);

                return templateIndex;
            })
            .catch((err) => {
                Logger.error('Failed to load template index', err);
                throw err;
            });
    }

    /**
     * Returns true if the template library can handle the URI.
     * @param {string} templateUri - the template URI
     * @return {boolean} true if the template library can process these URIs
     */
    static acceptsURI(templateUri) {
        return templateUri.startsWith('ap://');
    }

    /**
     * Parse a template URI into constituent parts
     * @param {string} templateUri - the URI of the template. E.g.
     * ap://helloworld@0.0.3#1cafebabe
     * @return {object} result of parsing
      * @throws {Error} if the URI is invalid
     */
    static parseURI(templateUri) {
        if (!templateUri.startsWith('ap://')) {
            throw new Error(`Unsupported protocol: ${templateUri}`);
        }

        const atIndex = templateUri.indexOf('@');
        const hashIndex = templateUri.indexOf('#');

        if (atIndex < 0 || hashIndex < 0) {
            throw new Error(`Invalid template specifier. Must contain @ and #: ${templateUri}`);
        }

        return {
            protocol: 'ap',
            templateName: templateUri.substring(5, atIndex),
            templateVersion: templateUri.substring(atIndex + 1, hashIndex),
            templateHash: templateUri.substring(hashIndex + 1),
        };
    }

    /**
     * Gets a template instance from a URI
     * @param {string} templateUri - the URI of the template. E.g.
     * ap://helloworld@0.0.3#cafebabe
     * @return {Promise} promise to a Template instance
     * @throws {Error} if the templateUri is invalid
     */
    async getTemplate(templateUri) {
        const cacheKey = this.getTemplateCacheKey(templateUri);

        const result = globalTemplateCache.get(cacheKey);
        if (result) {
            Logger.info('Returning template from cache', templateUri);
            return result;
        }

        const templateUriInfo = TemplateLibrary.parseURI(templateUri);
        const templateIndex = await this.getTemplateIndex();
        const templateMetadata = templateIndex[`${templateUriInfo.templateName}@${templateUriInfo.templateVersion}`];
        if(!templateMetadata) {
            throw new Error(`Failed to find template ${templateUri}`);
        }

        // fetch the template
        const template = await Template.fromUrl(templateMetadata.url);

        // check the hash matches
        const templateHash = template.getHash();
        if(templateHash !== templateUriInfo.templateHash) {
            Logger.warn(`Requested template ${templateUri} but the hash of the template is ${templateHash}`);
        }

        globalTemplateCache.set(cacheKey, template);

        return template;
    }

    /**
     * Returns the cache key used to cache the template index.
     * @param {object} [options] - the (optional) options
     * @returns {string} the cache key or null if the index should not be cached
     */
    getTemplateIndexCacheKey(options) {
        let prefix = '';
        if(options) {
            const hasher = crypto.createHash('sha256');
            hasher.update(stringify(options));
            prefix = `${hasher.digest('hex')}-`;
        }

        return `${this.url}/${prefix}template-library.json`;
    }

    /**
   * Returns the cache key used to cache access to a template.
   * @param {string} templateUri the URI for the template
   * @returns {string} the cache key or null if the template should not be cached
   */
    getTemplateCacheKey(templateUri) {
        return `${this.url}/${templateUri}`;
    }
}

module.exports = TemplateLibrary;
