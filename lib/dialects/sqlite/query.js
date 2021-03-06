var Utils         = require("../../utils")
  , AbstractQuery = require('../abstract/query')
  , QueryTypes    = require('../../query-types')

module.exports = (function() {
  var Query = function(database, sequelize, callee, options) {
    this.database = database
    this.sequelize = sequelize
    this.callee = callee
    this.options = Utils._.extend({
      logging: console.log,
      plain: false,
      raw: false
    }, options || {})

    this.checkLoggingOption()
  }
  Utils.inherit(Query, AbstractQuery)

  Query.prototype.getInsertIdField = function() {
    return 'lastID'
  }

  Query.prototype.run = function(sql) {
    var self = this

    this.sql = sql

    if (this.options.logging !== false) {
      this.options.logging('Executing (' + this.options.uuid + '): ' + this.sql)
    }

    var columnTypes = {}
    this.database.serialize(function() {
      var executeSql = function() {
        if (self.sql.indexOf('-- ') === 0) {
          // the sql query starts with a comment. don't bother the server with that ...
          Utils.tick(function() {
            self.emit('sql', self.sql)
            self.emit('success', null)
          })
        } else {
          self.database[getDatabaseMethod.call(self)](self.sql, function(err, results) {
            // allow clients to listen to sql to do their own logging or whatnot
            self.emit('sql', self.sql)

            if (err) {
              err.sql = self.sql
              onFailure.call(self, err)
            } else {
              this.columnTypes = columnTypes
              onSuccess.call(self, results, this)
            }
          })
        }
      }

      if ((getDatabaseMethod.call(self) === 'all')) {
        var tableNames = []
        if (self.options && self.options.tableNames) {
          tableNames = self.options.tableNames
        } else if (/FROM `(.*?)`/i.exec(self.sql)) {
          tableNames.push(/FROM `(.*?)`/i.exec(self.sql)[1])
        }

        if (!tableNames.length) {
          executeSql()
        } else {
          var execute = Utils._.after(tableNames.length, executeSql)
          
          tableNames.forEach(function (tableName) {
            if (tableName !== 'sqlite_master') {
              // get the column types
              self.database.all("PRAGMA table_info(" + tableName + ")", function(err, results) {
                if (!err) {
                  for (var i=0, l=results.length; i<l; i++) {
                    columnTypes[tableName + '.' + results[i].name] = columnTypes[results[i].name] = results[i].type
                  }
                }
                execute()
              });
            } else {
              execute()
            }
          })
        }
      } else {
        executeSql()
      }
    })

    return this
  }

  //private

  var getDatabaseMethod = function() {
    if (this.send('isInsertQuery') || this.send('isUpdateQuery') || (this.sql.toLowerCase().indexOf('CREATE TEMPORARY TABLE'.toLowerCase()) !== -1) || this.options.type === QueryTypes.BULKDELETE) {
      return 'run'
    } else {
      return 'all'
    }
  }

  var onSuccess = function(results, metaData) {
    var result = this.callee

    // add the inserted row id to the instance
    if (this.send('isInsertQuery', results, metaData)) {
      this.send('handleInsertQuery', results, metaData)
    }

    if (this.sql.indexOf('sqlite_master') !== -1) {
      result = results.map(function(resultSet) { return resultSet.name })
    } else if (this.send('isSelectQuery')) {
      if(!this.options.raw) {
        results = results.map(function(result) {
          for (var name in result) {
            if (result.hasOwnProperty(name) && metaData.columnTypes[name]) {
              if (metaData.columnTypes[name] === 'DATETIME') {
                // we need to convert the timestamps into actual date objects
                var val = result[name]
                if (val !== null) {
                  result[name] = new Date(val+'Z') // Z means UTC
                }
              } else if (metaData.columnTypes[name].lastIndexOf('BLOB') !== -1) {
                if (result[name]) {
                  result[name] = new Buffer(result[name])
                }
              }
            }
          }
          return result
        })
      }

      result = this.send('handleSelectQuery', results)
    } else if (this.send('isShowOrDescribeQuery')) {
      result = results
    } else if (this.sql.indexOf('PRAGMA INDEX_LIST') !== -1) {
      // this is the sqlite way of getting the indexes of a table
      result = results.map(function(result) {
        return {
          name:       result.name,
          tableName:  result.name.split('_')[0],
          unique:     (result.unique === 0)
        }
      })
    } else if (this.sql.indexOf('PRAGMA TABLE_INFO') !== -1) {
      // this is the sqlite way of getting the metadata of a table
      result = {}

      results.forEach(function(_result) {
        result[_result.name] = {
          type:         _result.type,
          allowNull:    (_result.notnull === 0),
          defaultValue: _result.dflt_value,
          primaryKey: (_result.pk === 1)
        }

        if (result[_result.name].type === 'TINYINT(1)') {
          result[_result.name].defaultValue = { '0': false, '1': true }[result[_result.name].defaultValue]
        }

        if (result[_result.name].defaultValue === undefined) {
          result[_result.name].defaultValue = null
        }

        if (typeof result[_result.name].defaultValue === 'string') {
          result[_result.name].defaultValue = result[_result.name].defaultValue.replace(/'/g, "")
        }
      })
    } else if (this.sql.indexOf('PRAGMA foreign_keys;') !== -1) {
      result = results[0]
    } else if (this.sql.indexOf('PRAGMA foreign_keys') !== -1) {
      result = results
    } else if ([QueryTypes.BULKUPDATE, QueryTypes.BULKDELETE].indexOf(this.options.type) !== -1) {
      result = metaData.changes 
    }

    this.emit('success', result)
  }

  var onFailure = function(err) {
    this.emit('error', err, this.callee)
  }

  return Query
})()
