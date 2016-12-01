'use strict'
/* globals Promise */
import _ from 'lodash'
import events from 'events'
import { EVENT } from '../constants'

const EventEmitter = events.EventEmitter

const ROUTING_KEYS = _.values(EVENT.ROUTING_KEY)

module.exports = class RabbitMQService extends EventEmitter{

  constructor(app, logger) {
    super()
    EventEmitter.call(this)
    this._app = app
    this.logger = logger
    this._subConn = null
    this._pubConn = null
    this._subQueue = null
  }

  /**
   * initialize rabbit mq connections / exchanges/ queues etc
   * @return {Promise} Resolved or rejected promise
   */
  init(rabbitmqURL, exchangeName, queueName) {
    var self = this
    self.exchangeName = exchangeName
    self.queueName = queueName
    return self._createConnection(rabbitmqURL)
      .then((conn) => {
        self.logger.debug('Publisher connection created')
        self._pubConn = conn
          // subscriber connection
        return self._createConnection(rabbitmqURL)
      }).then((conn) => {
        self.logger.debug('Subscriber connection created')
        self._subConn = conn
        return self._initSubscriber()
      })
      .catch((err) => {
        self.logger.error(err)
      })
  }

  /**
   * helper function to create a connection to rabbitmq
   * @param  {string} rabbitUrl url to connect to
   * @return {promise}           promise
   */
  _createConnection(rabbitUrl) {
    return require('amqplib').connect(rabbitUrl)
  }

  /**
   * Helper function to handle initializing subscribers
   * @return {promise} resolved promise
   */
  _initSubscriber() {
    var self = this
    var channel = null
      // create channel to setup exchanges + queues + bindings
      // on subscriber connection
    return self._subConn.createChannel()
      .then((ch) => {
        // assert / create exchanges
        self.logger.debug('Channel created')
        channel = ch
        return channel.assertExchange(self.exchangeName, 'topic', {
          durable: true
        })
      }).then(() => {
        // create queue
        // a single queue for challenge service will suffice
        self.logger.debug('Exchange created')
          // with default params - exclusive:false, durable: true, autoDelete: false
        return channel.assertQueue(self.queueName)
      }).then((qok) => {
        self.logger.debug('Queue %s created', self.queueName)
        self._subQueue = qok.queue
          // bindings for the queue
          // all these keys/bindings should be routed to the same queue
        self.logger.debug('Adding bindings: ', ROUTING_KEYS)
        var bindingPromises = _.map(ROUTING_KEYS, (rk) => {
          return channel.bindQueue(self._subQueue, self.exchangeName, rk)
        })
        return Promise.all(bindingPromises)
      }).then(() => {
        self._subChannel = channel
        return channel.consume(self._subQueue, (msg) => {
          let key = "external." + msg.fields.routingKey
          self.logger.debug('Received Message', key, msg.fields)
          // emit an event with the key and the message and a callback to acknowledge to reject the message
          this._app.emit(key, msg, (err) => {
            if (err) {
              self.logger.error(err)
              // not requeuing it right now - send to dead letter exchange
              channel.nack(msg, false, false)
              return
            }
            channel.ack(msg, false)
            return
          })
        })
      }).then(() => {
        self.logger.info('Waiting for messages .... ')
      }).catch((err) => {
        // channel.close()
        self.logger.error(err)
      })
  }

  /**
   * gracefully shutdown any open connections
   * @return {[type]} [description]
   */
  disconnect() {
    // TODO shutdown channel
    // shutdown connections
    var self = this
    return new Promise((resolve) => {
      var promises = _.map([self._subConn, self._pubConn], (conn) => {
        conn.close()
      })
      Promise.all(promises)
        .then(() => {
          self.logger.info('Disconnected from rabbitmq')
          resolve()
        }).catch((err) => {
          self.logger.error('ERROR Closing connection', err)
        })
    })
  }

  /**
   * Publish message to default exchange
   * @param  {string} key     routing key
   * @param  {object} payload message payload
   */
  publish(key, payload, props={}) {
    var channel = null
    var self = this
      // first create a channel - this is a lightweight connection
    return self._pubConn.createChannel()
      .then((ch) => {
        channel = ch
          // make sure the exchance exisits, else create it
        return channel.assertExchange(self.exchangeName, 'topic', {
          durable: true
        })
      }).then(() => {
        // publish the message
        props = _.defaults(props, { contentType: 'application/json'})
        channel.publish(
          self.exchangeName,
          key,
          new Buffer(JSON.stringify(payload)),
          props
        )
        self.logger.debug('Sent %s: %s', self.exchangeName, payload)
        return channel.close()
      })
      .catch((err) => {
        self.logger.error(err)
        return channel.close()
      })
  }
}