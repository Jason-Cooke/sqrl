/**
 * Copyright 2018 Twitter, Inc.
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */
import { SqrlInstance } from "../function/Instance";
import SqrlAst from "./SqrlAst";

import invariant from "../jslib/invariant";
import sqrlErrorWrap from "../compile/sqrlErrorWrap";
import { sqrlInvariant } from "../api/parse";
import { Ast, jsonAst } from "./Ast";
import { Expr, ConstantExpr, walkExpr, Slot, CallExpr } from "../expr/Expr";
import { SqrlSlot } from "../slot/SqrlSlot";
import { SqrlObject } from "../object/SqrlObject";
import { SqrlCompiledOutput } from "../compile/SqrlCompiledOutput";

const binaryOperatorToFunction = {
  "=": "_cmpE",
  "!=": "_cmpNE",
  ">": "_cmpG",
  ">=": "_cmpGE",
  "<": "_cmpL",
  "<=": "_cmpLE",
  "-": "_subtract",
  "+": "_add",
  "*": "_multiply",
  "%": "_modulo",
  or: "_or",
  and: "_and",
  contains: "_contains"
};

class AstExprState {
  currentIterator: string | null = null;

  constructor(
    public instance: SqrlInstance,
    private compiledSqrl: SqrlCompiledOutput
  ) {}

  costForExpr(expr: Expr): number {
    if (expr.type === "value") {
      return this.compiledSqrl.getSlotCost(expr.slot.name).recursiveCost;
    } else if (expr.type === "call") {
      return this.instance.getCost(expr.func);
    }
    return 1;
  }
  sortExprsByCostAsc(exprs: Expr[]): Expr[] {
    return exprs.sort(
      (left, right): number => {
        return this.costForExpr(left) - this.costForExpr(right);
      }
    );
  }

  hasSlot(name: string): boolean {
    return this.compiledSqrl.slots.hasOwnProperty(name);
  }
  getSlot(name: string): SqrlSlot {
    invariant(
      this.compiledSqrl.slots.hasOwnProperty(name),
      "Could not find slot with given name"
    );
    return this.compiledSqrl.slots[name];
  }

  exprForSlot(name: string): Expr {
    return this.compiledSqrl.exprForSlot(name);
  }

  wrapIterator<T>(iterator: string, callback: () => T): T {
    invariant(
      this.currentIterator === null,
      "Multiple levels of iterators are not supported."
    );
    this.currentIterator = iterator;
    const result: T = callback();
    this.currentIterator = null;
    return result;
  }
}

function constantExpr(value): ConstantExpr {
  return {
    type: "constant",
    value
  };
}

function ifExpr(exprs: Expr[]): Expr {
  const condition = exprs[0];
  if (condition.type === "constant") {
    if (SqrlObject.isTruthy(condition.value)) {
      return exprs[1];
    } else {
      return exprs[2];
    }
  }

  return {
    type: "if",
    exprs,
    // We can safely load the condition upfront, but be lazy on the other expressions
    load: condition.load
  };
}

function _astToExprList(
  exprAsts: Ast[],
  state: AstExprState,
  props: Expr,
  lazy = false
) {
  const exprs = exprAsts.map(exprAst => _astToExpr(exprAst, state));
  return {
    load: lazy ? [] : exprLoad(exprs),
    exprs,
    ...props
  };
}

function slotExpr(state: AstExprState, name: string): Expr {
  const slot = state.getSlot(name);

  // Reduce references to a constant slot to just that slot (if the value is simple)
  const slotExpr = state.exprForSlot(name);
  if (
    slotExpr.type === "constant" &&
    (slotExpr.value === null ||
      typeof slotExpr.value === "boolean" ||
      typeof slotExpr.value === "string" ||
      typeof slotExpr.value === "number" ||
      (Array.isArray(slotExpr.value) && !slotExpr.value.length))
  ) {
    return slotExpr;
  }
  return {
    type: "value",
    load: [slot],
    slot
  };
}

function boolExpr(state: AstExprState, expr: Expr): Expr {
  return {
    load: expr.load,
    type: "call",
    func: "bool",
    exprs: [expr]
  };
}

function exprLoad(exprs: Expr[]): Slot[] {
  const load: Set<Slot> = new Set();
  for (const expr of exprs) {
    if (expr.load) {
      expr.load.forEach(slot => load.add(slot));
    }
  }
  return Array.from(load);
}

function exprOrderedMinimalLoad(exprs: Expr[]): Slot[] {
  /**
   * For and/or we only want to preload the first part of the expression, *but*
   * in the case of an iterator, the code (currently) cannot handle a load/execute
   * so instead we load everything.
   */
  let hasIterator = false;
  for (const expr of exprs) {
    walkExpr(expr, node => {
      hasIterator = hasIterator || node.type === "iterator";
    });
  }

  if (hasIterator) {
    const set: Set<Slot> = new Set();
    exprs.forEach(expr => {
      expr.load.forEach(slot => set.add(slot));
    });
    return Array.from(set);
  } else {
    return exprs[0].load || [];
  }
}

function andExpr(state: AstExprState, args: Ast[]): Expr {
  let hadFalse = false;
  let hadNull = false;
  const exprs = args
    .map(arg => _astToExpr(arg, state))
    .filter(expr => {
      if (expr.type === "constant") {
        if (SqrlObject.isTruthy(expr.value)) {
          // Filter out truthy values
          return false;
        } else if (expr.value === null) {
          hadNull = true;
        } else {
          hadFalse = true;
        }
      }
      return true;
    });

  if (hadFalse) {
    return constantExpr(false);
  } else if (hadNull) {
    return constantExpr(null);
  } else if (exprs.length === 0) {
    return constantExpr(true);
  } else if (exprs.length === 1) {
    return boolExpr(state, exprs[0]);
  }

  const sortedExprs = state.sortExprsByCostAsc(exprs);
  return {
    type: "call",
    func: "_andSequential",
    exprs: [{ type: "state" }, ...sortedExprs],
    load: exprOrderedMinimalLoad(sortedExprs)
  };
}

function orExpr(state: AstExprState, args: Ast[]): Expr {
  let hadTrue = false;
  let hadNull = false;
  const exprs = args
    .map(arg => _astToExpr(arg, state))
    .filter(expr => {
      if (expr.type === "constant") {
        if (SqrlObject.isTruthy(expr.value)) {
          hadTrue = true;
        } else if (expr.value === null) {
          hadNull = true;
          return false;
        } else {
          return false;
        }
      }
      return true;
    });

  if (hadTrue) {
    return constantExpr(true);
  } else if (exprs.length === 0) {
    return constantExpr(hadNull ? null : false);
  } else if (hadNull) {
    // If we saw a null but still have other values, add it back
    exprs.push(constantExpr(null));
  } else if (exprs.length === 1) {
    return boolExpr(state, exprs[0]);
  }

  const sortedExprs = state.sortExprsByCostAsc(exprs);
  return makeCall(
    "_orSequential",
    [{ type: "state" }, ...sortedExprs],
    exprOrderedMinimalLoad(sortedExprs)
  );
}

function makeCall(func: string, exprs: Expr[], load?: Slot[]): CallExpr {
  if (!load) {
    load = exprLoad(exprs);
  }
  return {
    type: "call",
    func,
    exprs,
    load
  };
}

function callExpr(state: AstExprState, func: string, args: Ast[]): Expr {
  const { instance } = state;
  const props = instance.getProps(func);

  if (props.pure) {
    const argExprs = args.map(arg => _astToExpr(arg, state));
    const allConstant = argExprs.every(expr => expr.type === "constant");
    if (allConstant) {
      const constantExprs: ConstantExpr[] = argExprs.map(expr => {
        // @TODO: This is an unfortunate hack to make typescript happy
        if (expr.type !== "constant") {
          throw new Error("expected constant");
        }
        return expr;
      });
      const rv = state.instance.pureFunction[func](
        ...constantExprs.map(expr => expr.value)
      );
      return constantExpr(rv);
    }
  }

  if (func === "_slotWait") {
    return Object.assign(constantExpr(true), {
      load: args
        .filter(arg => {
          // Filter out wait for anything that is constant
          const expr = _astToExpr(arg, state);
          return expr.type !== "constant";
        })
        .map(arg => {
          if (arg.type !== "slot") {
            throw new Error("Expected slot ast for wait call");
          }
          return state.getSlot(arg.slotName);
        })
    });
  }

  // If the function takes a promise
  const lazy = !!props.lazyArguments;
  return _astToExprList(args, state, { type: "call", func }, lazy);
}

function _astToExpr(ast: Ast, state: AstExprState): Expr {
  return sqrlErrorWrap(
    {
      location: ast.location
    },
    (): Expr => {
      if (ast.type === "iterator") {
        invariant(
          state.currentIterator === ast.name,
          `Expected currentIterator to be %s was %s`,
          ast.name,
          state.currentIterator
        );
        return {
          type: "iterator",
          name: ast.name
        };
      } else if (ast.type === "feature") {
        sqrlInvariant(
          ast,
          state.hasSlot(ast.value),
          "Feature was not defined: %s",
          ast.value
        );
        return slotExpr(state, ast.value);
      } else if (ast.type === "slot") {
        return slotExpr(state, ast.slotName);
      } else if (ast.type === "state") {
        return { type: "state" };
      } else if (ast.type === "whenCause") {
        if (ast.slotName) {
          return slotExpr(state, ast.slotName);
        } else {
          return constantExpr(null);
        }
      } else if (ast.type === "if") {
        const exprAsts: Ast[] = [
          ast.condition,
          ast.trueBranch,
          ast.falseBranch
        ];

        return ifExpr(exprAsts.map(ast => _astToExpr(ast, state)));
      } else if (ast.type === "switch") {
        let result = ast.defaultCase
          ? _astToExpr(ast.defaultCase, state)
          : constantExpr(null);

        for (const { expr, where } of ast.cases) {
          // @TODO: Investigate old code if tests are failing due to where clauses:
          // const trueExpr = state.wrapWhere(truthTableWhere, () => _astToExpr(expr, state));
          const trueExpr = _astToExpr(expr, state);
          if (SqrlAst.isConstantTrue(where)) {
            result = trueExpr;
          } else {
            result = ifExpr([_astToExpr(where, state), trueExpr, result]);
          }
        }

        return result;
      } else if (ast.type === "call" || ast.type === "registeredCall") {
        const func = ast.func;
        const location = ast.location || null;
        return sqrlErrorWrap({ location }, () => {
          return callExpr(state, func, ast.args);
        });
      } else if (ast.type === "listComprehension") {
        // The value might still appear as a feature, so make sure to ignore it
        return state.wrapIterator(ast.iterator.name, () => {
          return _astToExprList([ast.input, ast.output, ast.where], state, {
            type: "listComprehension",
            iterator: ast.iterator.name
          });
        });
      } else if (ast.type === "not") {
        return callExpr(state, "_not", [ast.expr]);
      } else if (ast.type === "constant") {
        return constantExpr(ast.value);
      } else if (ast.type === "binary_expr" || ast.type === "boolean_expr") {
        let func: string;
        let args = [ast.left, ast.right];

        if (ast.operator === "or" || ast.operator === "and") {
          let nextAst = args[args.length - 1];
          while (
            nextAst.type === "boolean_expr" &&
            nextAst.operator === ast.operator
          ) {
            args = [
              ...args.slice(0, args.length - 1),
              nextAst.left,
              nextAst.right
            ];
            nextAst = args[args.length - 1];
          }
        }

        if (ast.operator === "in") {
          func = "_contains";
          args.reverse();
        } else if (ast.operator === "/") {
          args.unshift({ type: "state" });
          func = "_divide";
        } else if (ast.operator === "%") {
          args.unshift({ type: "state" });
          func = "_modulo";
        } else if (ast.operator === "or") {
          return orExpr(state, args);
        } else if (ast.operator === "and") {
          return andExpr(state, args);
        } else if (ast.operator === "is" || ast.operator === "is not") {
          invariant(
            args.length === 2 && SqrlAst.isConstantNull(args[1]),
            "Expected `null` value for right-hand side of IS"
          );
          let expr = callExpr(state, "_isNull", [args[0]]);
          if (ast.operator === "is not") {
            expr = makeCall("_not", [expr]);
          }
          return expr;
        } else {
          invariant(
            binaryOperatorToFunction.hasOwnProperty(ast.operator),
            "Could not find function for binary operator:: %s",
            ast.operator
          );
          func = binaryOperatorToFunction[ast.operator];
        }

        return callExpr(state, func, args);
      } else if (ast.type === "list") {
        return _astToExprList(ast.exprs, state, {
          type: "list"
        });
      } else {
        throw new Error("Unhandled ast: " + jsonAst(ast));
      }
    }
  );
}

function _exprExtractLoad(expr?, loaded: Set<SqrlSlot> = new Set()): Expr {
  const load = new Set();
  (expr.load || []).forEach(slot => {
    if (!loaded.has(slot)) {
      load.add(slot);
    }
  });

  // @TODO: reduce copying?
  expr = Object.assign({}, expr);
  delete expr.load;

  if (load.size) {
    return {
      type: "load",
      load: Array.from(load),
      exprs: [_exprExtractLoad(expr, new Set([...load, ...loaded]))]
    };
  }

  if (expr.exprs) {
    expr.exprs = expr.exprs.map(e => _exprExtractLoad(e, loaded));
  }
  return expr;
}

export function processExprAst(
  ast: Ast,
  compiledSqrl: SqrlCompiledOutput,
  instance: SqrlInstance
): Expr {
  const astExprState = new AstExprState(instance, compiledSqrl);
  return _exprExtractLoad(_astToExpr(ast, astExprState));
}
