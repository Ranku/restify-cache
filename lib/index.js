const redis = require('redis')
const _ = require('lodash')
var client
var config

var PAYLOAD_PREFIX = 'payload_'
var HEADER_PREFIX = 'header_'
/*
 * Sets the things
 * */
exports.config = function (cfg) {
  config = cfg || {}
  config.redisPort = config.redisPort || 6379
  config.redisHost = config.redisHost || 'localhost'
  config.redisAuth = config.redisAuth || false
  config.ttl = config.ttl || 60 * 60 // 1 hour
  config.cacheMethods = (config.cacheMethods) ? _.map(config.cacheMethods, (s) => { return s.toUpperCase() }) : ['GET'] // default to only caching GET requests
  config.cacheHeader = config.cacheHeader || false // caching on an arbitrary header

  client = redis.createClient(config.redisPort, config.redisHost, config.redisOptions)

  // attach additional prefix if needed
  if (config.prefix) {
    PAYLOAD_PREFIX += config.prefix + '_'
    HEADER_PREFIX += config.prefix + '_'
  }

  // check if redis auth was provided
  if (config.redisAuth) {
    client.auth(config.redisAuth)
  }

  return client
}

/*
 * Checks if we have the response in Redis
 * */
exports.before = function (req, res, next) {
  var url
  var _PAYLOAD_PREFIX = PAYLOAD_PREFIX
  var _HEADER_PREFIX = HEADER_PREFIX

  // if config wasn't called, lets set it now.
  if (!client) {
    exports.config()
  }

  // check if we aren't caching this request method and pass over
  if (req.method && !_.includes(config.cacheMethods, req.method)) {
    return next()
  }

  // check for arbitrary headers to cache on
  if (config.cacheHeader && _.includes(_.keys(req.headers), config.cacheHeader)) {
    _PAYLOAD_PREFIX = _PAYLOAD_PREFIX + req.headers[config.cacheHeader]
    _HEADER_PREFIX = _HEADER_PREFIX + req.headers[config.cacheHeader]
  }

  url = req.url
  client.get(_PAYLOAD_PREFIX + url, (err, payload) => {
    if (err) {
      return next(err)
    }
    client.get(_HEADER_PREFIX + url, (err, headers) => {
      var parsedHeaders
      var headerItem

      if (err) {
        return next(err)
      }

      if (payload && headers) {
        parsedHeaders = JSON.parse(headers)
        for (headerItem in parsedHeaders) {
          res.header(headerItem, parsedHeaders[headerItem])
        }

        res.header('X-Cache', 'HIT')
        res.writeHead(200)
        res.end(payload)
      } else {
        res.header('X-Cache', 'MISS')
        next()
      }
    })
  })
}

/*
 * Put the response into Redis
 * */
exports.after = function (req, res, route, error, cb) {
  var _PAYLOAD_PREFIX = PAYLOAD_PREFIX
  var _HEADER_PREFIX = HEADER_PREFIX

  if (error) {
    if (cb) {
      return cb(error)
    }
    return
  }

  // if config wasn't called, lets set it now.
  if (!client) {
    exports.config()
  }

  // check if we aren't caching this request method and pass over
  if (req.method && !_.includes(config.cacheMethods, req.method)) {
    if (cb) {
      return cb(null)
    }
    return
  }

  // check for arbitrary headers to cache on
  if (config.cacheHeader && _.includes(_.keys(req.headers), config.cacheHeader)) {
    _PAYLOAD_PREFIX = _PAYLOAD_PREFIX + req.headers[config.cacheHeader]
    _HEADER_PREFIX = _HEADER_PREFIX + req.headers[config.cacheHeader]
  }

  // console.log('redis: ' + _HEADER_PREFIX + req.url + ' : ' + JSON.stringify(res.headers()))

  client.set(_HEADER_PREFIX + req.url, JSON.stringify(res.headers()), function (err) {
    if (cb && err) {
      return cb(err)
    }
    client.expire(_HEADER_PREFIX + req.url, determineCacheTTL(res))

    // save the payload
    // console.log('redis: ' + _PAYLOAD_PREFIX + req.url + ' : ' + JSON.stringify(res._data()))
    client.set(_PAYLOAD_PREFIX + req.url, res._data, function (err) {
      if (cb && err) {
        return cb(err)
      }
      client.expire(_PAYLOAD_PREFIX + req.url, determineCacheTTL(res), cb)
    })
  })
}

function determineCacheTTL (res) {
  var cacheControl = res.getHeader('cache-control')

  if (cacheControl) {
    var maxAgeMatch = /max-age=(\d+)/.exec(cacheControl)

    if (maxAgeMatch) {
      return maxAgeMatch[1]
    }
  }

  return config.ttl
}
