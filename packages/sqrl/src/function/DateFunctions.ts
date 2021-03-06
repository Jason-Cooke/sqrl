/**
 * Copyright 2018 Twitter, Inc.
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */
import { StdlibRegistry } from "./Instance";
import { Ast, CallAst } from "../ast/Ast";

import { AstTypes as AT } from "../ast/AstTypes";
import SqrlAst from "../ast/SqrlAst";
import { SqrlObject } from "../object/SqrlObject";
import Moment = require("moment");

import { SqrlParserState } from "../compile/SqrlParserState";
import { buildSqrlError, sqrlInvariant } from "../api/parse";
import SqrlDateTime from "../object/SqrlDateTime";
import { Execution } from "../api/execute";

const VALID_TIMESPANS = {
  MS: 1,
  SECOND: 1000.0,
  MINUTE: 60 * 1000.0,
  HOUR: 60 * 60 * 1000.0,
  DAY: 24 * 60 * 60 * 1000.0,
  WEEK: 7 * 24 * 60 * 60 * 1000.0
};

const ISO_8601_DURATION_REGEXES = [
  /^P([0-9]+Y)?([0-9]+M)?([0-9]+W)?([0-9]+D)?(T([0-9]+H)?([0-9]+M)?([0-9]+(\\.[0-9]+)?S)?)?$/,
  /^P([^T]+|.*T.+)$/
];

function timeMsForValue(value: any) {
  if (value instanceof SqrlObject) {
    return value.tryGetTimeMs();
  }

  if (typeof value === "string") {
    const moment = Moment(value, Moment.ISO_8601);
    if (moment.isValid()) {
      return moment.valueOf();
    }
  }

  throw new Error("Invalid time value passed to timeMs");
}
export function registerDateFunctions(instance: StdlibRegistry) {
  instance.save(null, {
    name: "dateDiff",
    args: [AT.constant.string, AT.any, AT.any.optional],
    transformAst(state: SqrlParserState, ast: CallAst): Ast {
      const timeUnitAst = ast.args[0];

      if (
        timeUnitAst.type !== "constant" ||
        !VALID_TIMESPANS.hasOwnProperty(timeUnitAst.value)
      ) {
        throw buildSqrlError(
          ast,
          `invalid time unit for dateDiff. Expected one of ${JSON.stringify(
            Object.keys(VALID_TIMESPANS)
          )}`
        );
      }

      const startDateAst = ast.args[1];
      const endDateAst = ast.args[2] || null;
      sqrlInvariant(
        ast,
        endDateAst === null || endDateAst.type === "feature",
        "dateDiff expects an optional feature as second arg"
      );

      return SqrlAst.call("_dateDiff", [
        SqrlAst.constant(VALID_TIMESPANS[timeUnitAst.value]),
        startDateAst,
        endDateAst || SqrlAst.feature("SqrlClock")
      ]);
    },
    argstring: "unit, start, end?",
    docstring:
      "Returns the difference between the two dates in the given unit (millisecond, second, minute, hour, day, week)"
  });

  instance.save(
    function _dateDiff(msConversion: number, start, end) {
      start = timeMsForValue(start);
      end = timeMsForValue(end);
      return (end - start) / msConversion;
    },
    {
      allowSqrlObjects: true
    }
  );

  instance.save(
    function _formatDate(timeMs, format) {
      if (timeMs instanceof SqrlObject) {
        timeMs = timeMs.tryGetTimeMs();
      }
      if (typeof timeMs !== "number") {
        return null;
      }
      return Moment(timeMs, "x")
        .utcOffset(0)
        .format(format);
    },
    {
      allowSqrlObjects: true
    }
  );

  instance.save(null, {
    name: "formatDate",
    args: [AT.any, AT.any.optional],
    transformAst(state: SqrlParserState, ast: CallAst): Ast {
      let formatAst;
      if (ast.args.length === 1) {
        formatAst = SqrlAst.constant("dddd, MMMM Do YYYY, h:mm:ss a");
      } else {
        formatAst = ast.args[1];
        sqrlInvariant(
          ast,
          formatAst.type === "constant",
          "Expecting string format"
        );
        sqrlInvariant(
          ast,
          Moment(Moment().format(formatAst.value), formatAst.value).isValid(),
          "Invalid format string."
        );
      }
      return SqrlAst.call("_formatDate", [ast.args[0], formatAst]);
    },
    argstring: "date, format",
    docstring:
      "Format a given date according to a given format (see https://momentjs.com/docs/#/displaying/format/)"
  });

  instance.save(
    function _dateAdd(time, duration) {
      time = timeMsForValue(time);
      const value = Moment.utc(time)
        .add(Moment.duration(duration))
        .valueOf();
      if (!value) {
        throw new Error("Got null timeMs value from moment");
      }
      return new SqrlDateTime(value);
    },
    {
      allowSqrlObjects: true
    }
  );

  instance.save(null, {
    name: "dateAdd",
    transformAst(state: SqrlParserState, ast: CallAst): Ast {
      sqrlInvariant(
        ast,
        ast.args.length === 2,
        "Expected two arguments for dateAdd"
      );
      const durationAst = ast.args[1];

      // Allow non-constant durations, but check constants for valid values
      sqrlInvariant(
        durationAst,
        durationAst.type !== "constant" ||
          ISO_8601_DURATION_REGEXES.every(regex => {
            return regex.test(durationAst.value);
          }),
        "Expected a valid ISO8601 duration for dateAdd second parameter"
      );

      return SqrlAst.call("_dateAdd", ast.args);
    },
    argstring: "date, duration",
    docstring: "Add a given duration (ISO8601 format) to the given date"
  });

  instance.save(
    function date(value) {
      return new SqrlDateTime(timeMsForValue(value));
    },
    {
      allowSqrlObjects: true,
      args: [AT.any],
      argstring: "value",
      docstring: "Convert the given object or ISO8601 string to a date"
    }
  );

  instance.save(
    function dateFromMs(ms: number) {
      return ms && new SqrlDateTime(ms);
    },
    {
      args: [AT.any.number],
      argstring: "value",
      docstring:
        "Converts a count of milliseconds since the unix epoch to a date"
    }
  );

  instance.save(
    function timeMs(state: Execution, timeValue) {
      return timeMsForValue(timeValue);
    },
    {
      allowSqrlObjects: true,
      args: [AT.state, AT.any],
      argstring: "date",
      docstring:
        "Returns the count of milliseconds since the unix epoch for the provided value"
    }
  );
}
