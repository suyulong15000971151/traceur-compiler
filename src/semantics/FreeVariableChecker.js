// Copyright 2012 Traceur Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {ARGUMENTS} from '../syntax/PredefinedName.js';
import {
  BindingIdentifier,
  IdentifierExpression
} from '../syntax/trees/ParseTrees.js';
import {IdentifierToken} from '../syntax/IdentifierToken.js';
import {IDENTIFIER_EXPRESSION} from '../syntax/trees/ParseTreeType.js';
import {ParseTreeVisitor} from '../syntax/ParseTreeVisitor.js';
import {TYPEOF} from '../syntax/TokenType.js';

var global = this;

/**
 * Represents the link in the scope chain.
 */
class Scope {
  /**
   * @param {Scope} parent The parent scope, or null if top level scope.
   */
  constructor(parent) {
    this.parent = parent;
    this.references = Object.create(null);
    this.declarations = Object.create(null);
  }
}

/**
 * Gets the name of an identifier expression or token
 * @param {BindingIdentifier|IdentifierToken|string} name
 * @returns {string}
 */
function getVariableName(name) {
  if (name instanceof IdentifierExpression) {
    name = name.identifierToken;
  } else if (name instanceof BindingIdentifier) {
    name = name.identifierToken;
  }
  if (name instanceof IdentifierToken) {
    name = name.value;
  }
  return name;
}

/**
 * Finds the identifiers that are not bound in a program. Run this after all
 * module imports have been resolved.
 *
 * This is run after all transformations to simplify the analysis. In
 * particular we can ignore:
 *   - module imports
 *   - block scope (let/const)
 *   - classes
 * as all of these nodes will have been replaced. We assume that synthetic
 * variables (generated by Traceur) will bind correctly, so we don't worry
 * about binding them as well as user defined variables.
 */
export class FreeVariableChecker extends ParseTreeVisitor {
  /**
   * @param {ErrorReporter} reporter
   */
  constructor(reporter) {
    super();
    this.reporter_ = reporter;
    /** Current scope (block, program) */
    this.scope_ = null;
  }

  /**
   * Pushes a scope.
   * @return {Scope}
   */
  pushScope_() {
    return this.scope_ = new Scope(this.scope_);
  }

  /**
   * Pops scope, tracks proper matching of push_/pop_ operations.
   * @param {Scope} scope
   */
  pop_(scope) {
    if (this.scope_ != scope) {
      throw new Error('FreeVariableChecker scope mismatch');
    }

    this.validateScope_();

    this.scope_ = scope.parent;
  }

  visitProgram(tree, global) {
    var scope = this.pushScope_();

    // Declare variables from the global scope.
    // TODO(jmesserly): this should be done through the module loaders, and by
    // providing the user the option to import URLs like '@dom', but for now
    // just bind against everything in the global scope.
    var object = global;
    while (object) {
      Object.getOwnPropertyNames(object).forEach(this.declareVariable_, this);
      object = Object.getPrototypeOf(object);
    }

    this.visitList(tree.programElements);

    this.pop_(scope);
  }

  /**
   * Helper function for visitFunctionDeclaration, visitFunctionExpression and
   * visitArrowFunctionExpression.
   * @param {BindingIdentifier} name This is null for the arrow function.
   * @param {FormalParameterList} formalParameterList
   * @param {Block} body
   * @private
   */
  visitFunction_(name, formalParameterList, body) {
    var scope = this.pushScope_();

    this.visitAny(name);

    // Declare the function name, 'arguments' and formal parameters inside the
    // function
    this.declareVariable_(ARGUMENTS);
    this.visitAny(formalParameterList);

    this.visitAny(body);

    this.pop_(scope);
  }

  visitFunctionDeclaration(tree) {
    this.declareVariable_(tree.name);
    // Function declaration does not bind the name inside the function body.
    this.visitFunction_(null, tree.formalParameterList, tree.functionBody);
  }

  visitFunctionExpression(tree) {
    this.visitFunction_(tree.name, tree.formalParameterList, tree.functionBody);
  }

  visitArrowFunctionExpression(tree) {
    this.visitFunction_(null, tree.formalParameters, tree.functionBody);
  }

  visitGetAccessor(tree) {
    var scope = this.pushScope_();
    super.visitGetAccessor(tree);
    this.pop_(scope);
  }

  visitSetAccessor(tree) {
    var scope = this.pushScope_();
    super.visitSetAccessor(tree);
    this.pop_(scope);
  }

  visitCatch(tree) {
    var scope = this.pushScope_();
    super.visitCatch(tree);
    this.pop_(scope);
  }

  visitBindingIdentifier(tree) {
    this.declareVariable_(tree);
  }

  visitIdentifierExpression(tree) {
    var name = getVariableName(tree);
    var scope = this.scope_;
    if (!(name in scope.references)) {
      scope.references[name] = tree.location;
    }
  }

  visitUnaryExpression(tree) {
    // Allow typeof x to be a heuristic for allowing reading x later.
    if (tree.operator.type === TYPEOF &&
        tree.operand.type === IDENTIFIER_EXPRESSION) {
      this.declareVariable_(tree.operand);
    } else {
      super.visitUnaryExpression(tree);
    }
  }

  declareVariable_(tree) {
    var name = getVariableName(tree);
    if (name) {
      var scope = this.scope_;
      if (!(name in scope.declarations)) {
        scope.declarations[name] = tree.location;
      }
    }
  }

  /**
   * Once we've visited the body of a scope, we check that all variables were
   * declared. If they haven't been, we promote the references to the parent
   * scope (because ES can close over variables, as well as reference them
   * before declaration).
   *
   * At the top level scope we issue errors for any remaining free variables.
   */
  validateScope_() {
    var scope = this.scope_;

    // Promote any unresolved references to the parent scope.
    var errors = [];
    for (var name in scope.references) {
      if (!(name in scope.declarations)) {
        var location = scope.references[name];
        if (!scope.parent) {
          if (!location) {
            // If location is null, it means we're getting errors from code we
            // generated. This is an internal error.
            throw new Error(`generated variable ${name} is not defined`);
          }

          // If we're at the top level scope, then issue an error for
          // remaining free variables.
          errors.push([location.start, '%s is not defined', name]);
        } else if (!(name in scope.parent.references)) {
          scope.parent.references[name] = location;
        }
      }
    }

    if (errors.length) {
      // Issue errors in source order.
      errors.sort((x, y) => x[0].offset - y[0].offset);
      errors.forEach((e) => {
        this.reportError_(...e);
      });
    }
  }

  reportError_(...args) {
    this.reporter_.reportError(...args);
  }

  /**
   * Checks the program for free variables, and reports an error when it
   * encounters any.
   *
   * @param {ErrorReporter} reporter
   * @param {Program} tree
   */
  static checkProgram(reporter, tree) {
    new FreeVariableChecker(reporter).visitProgram(tree, global);
  }
}
