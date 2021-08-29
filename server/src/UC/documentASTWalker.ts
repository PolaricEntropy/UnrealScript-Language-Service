import { Range, Position } from 'vscode-languageserver-types';

import { ANTLRErrorListener, RecognitionException, Recognizer, Token, ParserRuleContext, CommonTokenStream } from 'antlr4ts';
import { AbstractParseTreeVisitor } from 'antlr4ts/tree/AbstractParseTreeVisitor';
import { ErrorNode } from 'antlr4ts/tree/ErrorNode';

import * as UCGrammar from '../antlr/UCParser';
import { UCLexer } from '../antlr/UCLexer';
import { UCParserVisitor } from '../antlr/UCParserVisitor';
import { UCPreprocessorParserVisitor } from '../antlr/UCPreprocessorParserVisitor';
import * as UCMacro from '../antlr/UCPreprocessorParser';

import { rangeFromBounds, rangeFromBound, rangeFromCtx } from './helpers';
import {
	toName,
	NAME_CLASS, NAME_ARRAY, NAME_REPLICATION,
	NAME_NONE, NAME_NAME, NAME_DELEGATE, NAME_ENUMCOUNT,
	NAME_DEFAULT, NAME_OBJECT, NAME_MAP
} from './names';

import {
	Identifier, ISymbol, ISymbolContainer, UCConstSymbol,
	UCDefaultPropertiesBlock, UCEnumMemberSymbol, UCEnumSymbol,
	UCMethodSymbol, UCLocalSymbol, UCObjectSymbol,
	UCPropertySymbol, UCScriptStructSymbol, UCStateSymbol,
	UCStructSymbol, UCSymbol, UCSymbolReference,
	ITypeSymbol, UCObjectTypeSymbol, UCQualifiedTypeSymbol,
	UCDocumentClassSymbol, UCReplicationBlock,
	MethodSpecifiers, UCEventSymbol, UCBinaryOperatorSymbol,
	UCDelegateSymbol, UCPostOperatorSymbol, UCPreOperatorSymbol,
	FieldModifiers, ParamModifiers,
	UCParamSymbol, UCTypeKind,
	UCIntTypeSymbol, UCFloatTypeSymbol,
	UCByteTypeSymbol, UCStringTypeSymbol,
	UCNameTypeSymbol, UCBoolTypeSymbol,
	UCPointerTypeSymbol, UCButtonTypeSymbol,
	UCDelegateTypeSymbol, UCArrayTypeSymbol,
	UCMapTypeSymbol,
	ObjectsTable
} from './Symbols';

import { SyntaxErrorNode } from './diagnostics/diagnostic';

import {
	UCBlock, IStatement, UCExpressionStatement, UCLabeledStatement,
	UCReturnStatement, UCGotoStatement, UCIfStatement, UCWhileStatement,
	UCDoUntilStatement, UCForEachStatement, UCForStatement, UCSwitchStatement,
	UCCaseClause, UCDefaultClause, UCAssertStatement
} from './statements';

import { setEnumMember } from './indexer';

import { UCDocument } from './document';
import {
	IExpression,
	UCConditionalExpression, UCBinaryOperatorExpression,
	UCPreOperatorExpression, UCParenthesizedExpression,
	UCPropertyAccessExpression, UCCallExpression, UCElementAccessExpression,
	UCNewExpression, UCMetaClassExpression, UCSuperExpression,
	UCPredefinedAccessExpression, UCPredefinedPropertyAccessExpression,
	UCMemberExpression,
	UCNoneLiteral, UCStringLiteral, UCNameLiteral,
	UCBoolLiteral, UCFloatLiteral, UCIntLiteral, UCObjectLiteral,
	UCVectLiteral, UCRotLiteral, UCRngLiteral,
	UCNameOfLiteral, UCArrayCountExpression, UCSizeOfLiteral, UCArrayCountLiteral,
	UCDefaultAssignmentExpression, UCDefaultStructLiteral,
	UCAssignmentOperatorExpression, UCPostOperatorExpression, UCByteLiteral
} from './expressions';

function idFromCtx(ctx: ParserRuleContext) {
	const identifier: Identifier = {
		name: toName(ctx.text),
		range: rangeFromBound(ctx.start)
	};

	return identifier;
}

function idFromToken(token: Token) {
	const identifier: Identifier = {
		name: toName(token.text!),
		range: rangeFromBound(token)
	};

	return identifier;
}

function memberFromIdCtx(ctx: UCGrammar.IdentifierContext): UCMemberExpression {
	const expression = new UCMemberExpression(new UCSymbolReference(idFromCtx(ctx)));
	return expression;
}

function blockFromStatementCtx(
	visitor: DocumentASTWalker,
	ctx: ParserRuleContext & { statement: () => UCGrammar.StatementContext[] }
): UCBlock | undefined {
	const statementNodes = ctx.statement();
	if (!statementNodes || statementNodes.length === 0) {
		return undefined;
	}

	const startToken = statementNodes[0].start;
	const stopToken = statementNodes[statementNodes.length - 1].stop;
	const block = new UCBlock(rangeFromBounds(startToken, stopToken));
	try {
		block.statements = new Array(statementNodes.length);
		for (let i = 0; i < statementNodes.length; ++i) {
			const statement: IStatement = statementNodes[i].accept(visitor);
			block.statements[i] = statement;
		}
	} catch (err) {
		console.error(`An errored ocurred when building statements for a codeblock in scope '${visitor.scope().getQualifiedName()}'!`);
		throw err;
	}
	return block;
}

function typeFromIds(identifiers: Identifier[]): ITypeSymbol | undefined {
	if (identifiers.length === 1) {
		return new UCObjectTypeSymbol(identifiers[0], undefined, UCTypeKind.Object);
	} else if (identifiers.length > 1) {
		const get = (i: number): UCQualifiedTypeSymbol => {
			const type = new UCObjectTypeSymbol(identifiers[i]);
			if (i === 0) {
				type.setValidTypeKind(UCTypeKind.Object);
			}
			const leftType = i - 1 > -1 ? get(--i) : undefined;
			return new UCQualifiedTypeSymbol(type, leftType);
		};

		return get(identifiers.length - 1);
	}
	return undefined;
}

function fetchSurroundingComments(tokenStream: CommonTokenStream, ctx: ParserRuleContext): Token[] | undefined {
	const myTokenIndex = ctx.stop ? ctx.stop.tokenIndex : ctx.start.tokenIndex;
	const leadingComment = tokenStream.getHiddenTokensToRight(myTokenIndex, UCLexer.COMMENTS_CHANNEL)
		.filter(token => token.charPositionInLine !== 0)
		.shift();

	if (leadingComment) {
		return [leadingComment];
	}

	const headerComment = tokenStream.getHiddenTokensToLeft(myTokenIndex, UCLexer.COMMENTS_CHANNEL)
		.filter(token => token.charPositionInLine === 0);

	return headerComment;
}

function createQualifiedType(ctx: UCGrammar.QualifiedIdentifierContext, kind?: UCTypeKind) {
	const leftId: Identifier = idFromCtx(ctx._left);
	const leftType = new UCObjectTypeSymbol(leftId, rangeFromCtx(ctx._left), kind);

	if (ctx._right) {
		const rightId: Identifier = idFromCtx(ctx._right);
		const rightType = new UCObjectTypeSymbol(rightId, rangeFromCtx(ctx._right));

		const symbol = new UCQualifiedTypeSymbol(rightType, new UCQualifiedTypeSymbol(leftType));
		switch (kind) {
			case UCTypeKind.Struct:
				leftType.setValidTypeKind(UCTypeKind.Class);
				break;

			case UCTypeKind.State:
				leftType.setValidTypeKind(UCTypeKind.Class);
				break;

			case UCTypeKind.Delegate:
				leftType.setValidTypeKind(UCTypeKind.Class);
				rightType.setValidTypeKind(UCTypeKind.Delegate);
				break;

			case UCTypeKind.Class:
				leftType.setValidTypeKind(UCTypeKind.Package);
				break;

			default:
				leftType.setValidTypeKind(UCTypeKind.Class);
				break;
		}
		return symbol;
	}
	return leftType;
}

export class DocumentASTWalker extends AbstractParseTreeVisitor<ISymbol | IExpression | IStatement | Identifier | undefined> implements UCPreprocessorParserVisitor<any>, UCParserVisitor<any>, ANTLRErrorListener<Token> {
	private scopes: ISymbolContainer<ISymbol>[] = [];
	tokenStream: CommonTokenStream;

	constructor(private document: UCDocument) {
		super();
		this.scopes.push(document.classPackage);
	}

	push(newContext: UCStructSymbol) {
		this.scopes.push(newContext);
	}

	pop() {
		this.scopes.pop();
	}

	scope<T extends ISymbolContainer<ISymbol> & ISymbol>(): T {
		return <T>this.scopes[this.scopes.length - 1];
	}

	declare(symbol: UCSymbol, ctx?: ParserRuleContext) {
		// console.assert(symbol.getId(), `Attempted to add a symbol with no Id! "${symbol.getQualifiedName()}".`);
		const scope = this.scope();
		scope.addSymbol(symbol);
		if (ctx) {
			symbol.description = fetchSurroundingComments(this.tokenStream, ctx);
		}
	}

	syntaxError(_recognizer: Recognizer<Token, any>,
		offendingSymbol: Token | undefined,
		_line: number,
		_charPositionInLine: number,
		msg: string,
		error: RecognitionException | undefined
	) {
		const range = Range.create(Position.create(_line - 1, _charPositionInLine), Position.create(_line - 1, _charPositionInLine));
		const node = new SyntaxErrorNode(range, msg);
		this.document.nodes.push(node);
	}

	visitErrorNode(errNode: ErrorNode) {
		const node = new SyntaxErrorNode(rangeFromBound(errNode.symbol), '(ANTLR Node Error) ' + errNode.text);
		this.document.nodes.push(node);
		return undefined!;
	}

	visitMacroDefine(ctx: UCMacro.MacroDefineContext) {
		if (!ctx.isActive) {
			// TODO: mark range?
			return undefined;
		}
		const macro = ctx._MACRO_SYMBOL;
		const identifier = idFromToken(macro);
		// TODO: custom class
		const symbol = new UCPropertySymbol(identifier);
		this.document.addSymbol(symbol);
		return undefined;
	}

	visitIdentifier(ctx: UCGrammar.IdentifierContext) {
		const identifier: Identifier = {
			name: toName(ctx.text),
			range: rangeFromBound(ctx.start)
		};

		return identifier;
	}

	visitQualifiedIdentifier(ctx) {
		return createQualifiedType(ctx);
	}

	visitTypeDecl(typeDeclNode: UCGrammar.TypeDeclContext): ITypeSymbol {
		const rule = typeDeclNode.getChild(0) as ParserRuleContext;
		const ruleIndex = rule.ruleIndex;
		if (ruleIndex === UCGrammar.UCParser.RULE_structDecl) {
			const symbol: UCStructSymbol = this.visitStructDecl(rule as UCGrammar.StructDeclContext);
			const type = new UCObjectTypeSymbol(symbol.id, undefined, UCTypeKind.Struct);
			// noIndex: true, because the struct will be indexed in its own index() call.
			type.setReference(symbol, this.document, true);
			return type;
		} else if (ruleIndex === UCGrammar.UCParser.RULE_enumDecl) {
			const symbol: UCEnumSymbol = this.visitEnumDecl(rule as UCGrammar.EnumDeclContext);
			const type = new UCObjectTypeSymbol(symbol.id, undefined, UCTypeKind.Enum);
			// noIndex: true, because the enum will be indexed in its own index() call.
			type.setReference(symbol, this.document, true);
			return type;
		}
		else if (ruleIndex === UCGrammar.UCParser.RULE_primitiveType) {
			const tokenType = rule.start.type;
			const type = tokenType === UCLexer.KW_BYTE
				? UCByteTypeSymbol
				: tokenType === UCLexer.KW_FLOAT
				? UCFloatTypeSymbol
				: tokenType === UCLexer.KW_INT
				? UCIntTypeSymbol
				: tokenType === UCLexer.KW_STRING
				? UCStringTypeSymbol
				: tokenType === UCLexer.KW_NAME
				? UCNameTypeSymbol
				: tokenType === UCLexer.KW_BOOL
				? UCBoolTypeSymbol
				: tokenType === UCLexer.KW_POINTER
				? UCPointerTypeSymbol
				: tokenType === UCLexer.KW_BUTTON
				? UCButtonTypeSymbol
				: undefined;

			if (!type) {
				throw "Unknown type for predefinedType() was encountered!";
			}

			const identifier: Identifier = {
				name: type.getStaticName(),
				range: rangeFromBounds(rule.start, rule.stop)
			};
			const symbol = new type(identifier);
			return symbol;
		} else if (ruleIndex === UCGrammar.UCParser.RULE_qualifiedIdentifier) {
			const symbol: ITypeSymbol = createQualifiedType(rule as UCGrammar.QualifiedIdentifierContext, UCTypeKind.Type);
			return symbol;
		} else if (rule instanceof UCGrammar.ClassTypeContext) {
			const identifier: Identifier = {
				name: NAME_CLASS,
				range: rangeFromBound(rule.start)
			};
			const symbol = new UCObjectTypeSymbol(identifier, rangeFromBounds(rule.start, rule.stop), UCTypeKind.Class);

			const idNode = rule.identifier();
			if (idNode) {
				const identifier = idFromCtx(idNode);
				symbol.baseType = new UCObjectTypeSymbol(identifier, undefined, UCTypeKind.Class);
			}
			return symbol;
		} else if (rule instanceof UCGrammar.ArrayTypeContext) {
			const identifier: Identifier = {
				name: NAME_ARRAY,
				range: rangeFromBound(rule.start)
			};
			const symbol = new UCArrayTypeSymbol(identifier, rangeFromBounds(rule.start, rule.stop));

			const baseTypeNode = rule.varType();
			if (baseTypeNode) {
				const type: ITypeSymbol | undefined = this.visitTypeDecl(baseTypeNode.typeDecl());
				symbol.baseType = type;
			}
			return symbol;
		} else if (rule instanceof UCGrammar.DelegateTypeContext) {
			const identifier: Identifier = {
				name: NAME_DELEGATE,
				range: rangeFromBound(rule.start)
			};
			const symbol = new UCDelegateTypeSymbol(identifier, rangeFromBounds(rule.start, rule.stop));
			symbol.setValidTypeKind(UCTypeKind.Delegate);

			const qualifiedNode = rule.qualifiedIdentifier();
			if (qualifiedNode) {
				const type: ITypeSymbol = createQualifiedType(qualifiedNode, UCTypeKind.Delegate);
				symbol.baseType = type;
			}
			return symbol;
		} else if (rule instanceof UCGrammar.MapTypeContext) {
			const identifier: Identifier = {
				name: NAME_MAP,
				range: rangeFromBound(rule.start)
			};
			const symbol = new UCMapTypeSymbol(identifier, rangeFromBounds(rule.start, rule.stop));
			return symbol;
		}

		throw "Encountered an unknown typeDecl:" + typeDeclNode.toString();
	}

	visitClassDecl(ctx: UCGrammar.ClassDeclContext) {
		// Most of the time a document's tree is invalid as the end-user is writing code.
		// Therefore the parser may mistake "class'Object' <stuff here>;"" for a construction of a class declaration, this then leads to a messed up scope stack.
		// Or alternatively someone literally did try to declare another class?
		if (this.document.class) {
			this.document.nodes.push(new SyntaxErrorNode(rangeFromCtx(ctx), 'Cannot declare a class within another class!'));
			return undefined;
		}

		const identifier: Identifier = idFromCtx(ctx.identifier());
		const symbol = new UCDocumentClassSymbol(identifier, rangeFromBounds(ctx.start, ctx.stop));
		symbol.document = this.document;
		this.document.class = symbol; // Important!, must be assigned before further parsing.
		this.document.addSymbol(symbol);

		const extendsNode = ctx.extendsClause();
		if (extendsNode) {
			symbol.extendsType = createQualifiedType(extendsNode._id, UCTypeKind.Class);
		}

		const withinNode = ctx.withinClause();
		if (withinNode) {
			symbol.withinType = createQualifiedType(withinNode._id, UCTypeKind.Class);
		}

		const modifierNodes = ctx.classModifier();
		for (const modifierNode of modifierNodes) {
			const idNode = modifierNode.identifier();
			const modifierArgumentNodes = modifierNode.modifierArguments();
			switch (idNode.text.toLowerCase()) {
				case 'dependson': {
					if (modifierArgumentNodes) {
						if (!symbol.dependsOnTypes) {
							symbol.dependsOnTypes = [];
						}
						for (const valueNode of modifierArgumentNodes.modifierValue()) {
							const identifier: Identifier = {
								name: toName(valueNode.text),
								range: rangeFromBounds(valueNode.start, valueNode.stop)
							};
							const typeSymbol = new UCObjectTypeSymbol(identifier, undefined, UCTypeKind.Class);
							symbol.dependsOnTypes.push(typeSymbol);
						}
					}
					break;
				}
				case 'implements': {
					if (modifierArgumentNodes) {
						if (!symbol.implementsTypes) {
							symbol.implementsTypes = [];
						}
						for (const valueNode of modifierArgumentNodes.modifierValue()) {
							const identifier: Identifier = {
								name: toName(valueNode.text),
								range: rangeFromBounds(valueNode.start, valueNode.stop)
							};
							const typeSymbol = new UCObjectTypeSymbol(identifier, undefined, UCTypeKind.Class);
							symbol.implementsTypes.push(typeSymbol);
						}
					}
					break;
				}
			}
		}

		this.declare(symbol, ctx); // push to package
		this.push(symbol);

		return symbol;
	}

	visitConstDecl(ctx: UCGrammar.ConstDeclContext) {
		const identifier: Identifier = idFromCtx(ctx.identifier());
		const symbol = new UCConstSymbol(identifier, rangeFromBounds(ctx.start, ctx.stop));

		// Ensure that all constant declarations are always declared as a top level field (i.e. class)
		this.document.class!.addSymbol(symbol);
		symbol.description = fetchSurroundingComments(this.tokenStream, ctx);

		const exprNode = ctx._expr;
		if (exprNode) {
			symbol.expression = exprNode.accept(this);
		}
		return symbol;
	}

	visitEnumDecl(ctx: UCGrammar.EnumDeclContext) {
		const identifier: Identifier = idFromCtx(ctx.identifier());
		const symbol = new UCEnumSymbol(identifier, rangeFromBounds(ctx.start, ctx.stop));
		this.declare(symbol, ctx);
		ObjectsTable.addSymbol(symbol);

		this.push(symbol);
		try {
			let count = 0;
			const memberNodes = ctx.enumMember();
			for (const memberNode of memberNodes) {
				const memberSymbol = memberNode.accept(this);
				// HACK: overwrite define() outer let.
				memberSymbol.outer = symbol;
				memberSymbol.value = count++;
			}

			// Insert the compiler-generated enum member "EnumCount".
			// TODO: Insert another generated member, e.g. NM_MAX for ENetMode
			const enumCountMember = new UCEnumMemberSymbol({ name: NAME_ENUMCOUNT, range: symbol.getRange() } as Identifier);
			this.declare(enumCountMember);
			enumCountMember.outer = symbol;
			enumCountMember.value = count;
		} finally {
			this.pop();
		}
		return symbol;
	}

	visitEnumMember(ctx: UCGrammar.EnumMemberContext) {
		const identifier: Identifier = idFromCtx(ctx.identifier());
		const symbol = new UCEnumMemberSymbol(identifier);
		this.declare(symbol);
		setEnumMember(symbol);
		return symbol;
	}

	visitStructDecl(ctx: UCGrammar.StructDeclContext) {
		const identifier: Identifier = idFromCtx(ctx.identifier());
		const symbol = new UCScriptStructSymbol(identifier, rangeFromBounds(ctx.start, ctx.stop));

		const extendsNode = ctx.extendsClause();
		if (extendsNode) {
			symbol.extendsType = createQualifiedType(extendsNode._id, UCTypeKind.Struct);
		}

		this.declare(symbol, ctx);
		ObjectsTable.addSymbol(symbol);

		this.push(symbol);
		try {
			const memberNodes = ctx.structMember();
			if (memberNodes) for (const member of memberNodes) {
				member.accept(this);
			}
		} finally {
			this.pop();
		}
		return symbol;
	}

	visitReplicationBlock(ctx: UCGrammar.ReplicationBlockContext) {
		const identifier: Identifier = {
			name: NAME_REPLICATION,
			range: rangeFromBound(ctx.start)
		};
		const symbol = new UCReplicationBlock(identifier, rangeFromBounds(ctx.start, ctx.stop));
		symbol.super = this.document.class;
		this.declare(symbol, ctx);

		const statementNodes = ctx.replicationStatement();
		if (!statementNodes) {
			return;
		}

		const block = new UCBlock(rangeFromBounds(ctx.start, ctx.stop));
		block.statements = Array(statementNodes.length);
		for (let i = 0; i < statementNodes.length; ++i) {
			const statement = statementNodes[i].accept(this);
			block.statements[i] = statement;

			const idNodes = statementNodes[i].identifier();
			if (idNodes) for (const idNode of idNodes) {
				const identifier = idFromCtx(idNode);

				const symbolRef = new UCSymbolReference(identifier);
				symbolRef.outer = this.document.class;
				symbol.symbolRefs.set(symbolRef.getId(), symbolRef);
			}
		}
		symbol.block = block;
		return symbol;
	}

	visitFunctionDecl(ctx: UCGrammar.FunctionDeclContext) {
		const nameNode: UCGrammar.FunctionNameContext | undefined = ctx.functionName();
		if (!nameNode) {
			console.error('no name node found for function!', ctx.toString());
			return undefined;
		}

		let modifiers: FieldModifiers = 0;
		let specifiers: MethodSpecifiers = MethodSpecifiers.None;
		let precedence: number | undefined;

		const specifierNodes = ctx.functionSpecifier();
		for (const specifier of specifierNodes) {
			switch (specifier.start.type) {
				case UCGrammar.UCParser.KW_NATIVE:
					modifiers |= FieldModifiers.Native;
					break;
				case UCGrammar.UCParser.KW_CONST:
					modifiers |= FieldModifiers.Const;
					break;
				case UCGrammar.UCParser.KW_PROTECTED:
					modifiers |= FieldModifiers.Protected;
					break;
				case UCGrammar.UCParser.KW_PRIVATE:
					modifiers |= FieldModifiers.Private;
					break;
				case UCGrammar.UCParser.KW_FUNCTION:
					specifiers |= MethodSpecifiers.Function;
					break;
				case UCGrammar.UCParser.KW_OPERATOR:
					specifiers |= MethodSpecifiers.Operator;
					if (specifier._operatorPrecedence) {
						precedence = Number(specifier._operatorPrecedence.text);
					}
					break;
				case UCGrammar.UCParser.KW_PREOPERATOR:
					specifiers |= MethodSpecifiers.PreOperator;
					break;
				case UCGrammar.UCParser.KW_POSTOPERATOR:
					specifiers |= MethodSpecifiers.PostOperator;
					break;
				case UCGrammar.UCParser.KW_DELEGATE:
					specifiers |= MethodSpecifiers.Delegate;
					break;
				case UCGrammar.UCParser.KW_EVENT:
					specifiers |= MethodSpecifiers.Event;
					break;
				case UCGrammar.UCParser.KW_STATIC:
					specifiers |= MethodSpecifiers.Static;
					break;
				case UCGrammar.UCParser.KW_FINAL:
					specifiers |= MethodSpecifiers.Final;
					break;
			}
		}

		const type = (specifiers & MethodSpecifiers.Function)
			? UCMethodSymbol
			: (specifiers & MethodSpecifiers.Event)
			? UCEventSymbol
			: (specifiers & MethodSpecifiers.Operator)
			? UCBinaryOperatorSymbol
			: (specifiers & MethodSpecifiers.PreOperator)
			? UCPreOperatorSymbol
			: (specifiers & MethodSpecifiers.PostOperator)
			? UCPostOperatorSymbol
			: (specifiers & MethodSpecifiers.Delegate)
			? UCDelegateSymbol
			: UCMethodSymbol;

		if ((specifiers & MethodSpecifiers.HasKind) === 0) {
			this.document.nodes.push(new SyntaxErrorNode(rangeFromBound(ctx.start),
				`Method must be declared as either one of the following: (Function, Event, Operator, PreOperator, PostOperator, or Delegate).`
			));
		}

		const range = rangeFromBounds(ctx.start, ctx.stop);
		const identifier: Identifier = idFromCtx(nameNode);
		const symbol = new type(identifier, range);
		symbol.specifiers = specifiers;
		symbol.modifiers = modifiers;

		if (precedence) {
			(symbol as UCBinaryOperatorSymbol).precedence = precedence;
		}

		this.declare(symbol, ctx);

		if (ctx._returnType) {
			symbol.returnType = this.visitTypeDecl(ctx._returnType);
		}

		this.push(symbol);
		try {
			if (ctx._params) {
				symbol.params = [];
				const paramNodes = ctx._params.paramDecl();
				for (const paramNode of paramNodes) {
					const propSymbol = paramNode.accept(this);
					symbol.params.push(propSymbol);
				}

				// if ((specifiers & MethodSpecifiers.Operator) !== 0) {
				// 	const leftType = symbol.params[0].getType();
				// 	const rightType = symbol.params[1].getType();

				// 	const leftTypeName = leftType && leftType.getId();
				// 	const rightTypeName = rightType && rightType.getId();

				// 	const overloadedName = symbol.getId().toString() + leftTypeName + rightTypeName;
				// }
			}

			try {
				const bodyNode = ctx.functionBody();
				if (bodyNode) {
					bodyNode.accept(this);
				}
			} catch (err) {
				console.error(`Encountered an error while constructing the body for function '${symbol.getQualifiedName()}'`, err);
			}
		} catch (err) {
			console.error(`Encountered an error while constructing function '${symbol.getQualifiedName()}'`, err);
		} finally {
			this.pop();
		}
		return symbol;
	}

	visitFunctionName(ctx: UCGrammar.FunctionNameContext): Identifier {
		const idNode = ctx.identifier();
		if (idNode) {
			return idFromCtx(idNode);
		}
		const opNode = ctx.operatorName();
		if (opNode) {
			const identifier: Identifier = {
				name: toName(opNode.text),
				range: rangeFromBound(opNode.start)
			};
			return identifier;
		}
		return { name: NAME_NONE, range: rangeFromBound(ctx.start) } as Identifier;
	}

	visitFunctionBody(ctx: UCGrammar.FunctionBodyContext) {
		const memberNodes = ctx.functionMember();
		if (memberNodes) for (const member of memberNodes) {
			member.accept(this);
		}

		const method = this.scope<UCMethodSymbol>();
		method.block = blockFromStatementCtx(this, ctx);
	}

	visitParamDecl(ctx: UCGrammar.ParamDeclContext) {
		let modifiers: FieldModifiers = 0;
		let paramModifiers: ParamModifiers = 0;
		const modifierNodes = ctx.paramModifier();
		for (const modNode of modifierNodes) {
			switch (modNode.start.type) {
				case UCGrammar.UCParser.KW_CONST:
					modifiers |= FieldModifiers.Const;
					break;
				case UCGrammar.UCParser.KW_OUT:
					paramModifiers |= ParamModifiers.Out;
					break;
				case UCGrammar.UCParser.KW_OPTIONAL:
					paramModifiers |= ParamModifiers.Optional;
					break;
				case UCGrammar.UCParser.KW_COERCE:
					paramModifiers |= ParamModifiers.Coerce;
					break;
			}
		}

		const propTypeNode = ctx.typeDecl();
		const typeSymbol = this.visitTypeDecl(propTypeNode);

		const varNode = ctx.variable();

		const identifier: Identifier = idFromCtx(varNode.identifier());
		const symbol = new UCParamSymbol(identifier, rangeFromBounds(ctx.start, ctx.stop));
		symbol.type = typeSymbol;
		symbol.modifiers = modifiers;
		symbol.paramModifiers = paramModifiers;

		const exprNode = ctx.expression();
		if (exprNode) {
			symbol.defaultExpression = exprNode.accept(this);
		}

		symbol.walk(this, varNode);
		this.declare(symbol);
		return symbol;
	}

	visitLocalDecl(ctx: UCGrammar.LocalDeclContext) {
		const propTypeNode = ctx.typeDecl();
		const typeSymbol = this.visitTypeDecl(propTypeNode);

		const varNodes = ctx.variable();
		for (const varNode of varNodes) {
			const symbol: UCLocalSymbol = varNode.accept(this);
			symbol.type = typeSymbol;
			this.declare(symbol);
		}
		return undefined;
	}

	visitVarDecl(ctx: UCGrammar.VarDeclContext) {
		const declTypeNode = ctx.varType();
		if (!declTypeNode) {
			return;
		}

		let modifiers: FieldModifiers = 0;
		const modifierNodes = declTypeNode.variableModifier();
		for (const modNode of modifierNodes) {
			switch (modNode.start.type) {
				case UCGrammar.UCParser.KW_CONST:
					modifiers |= FieldModifiers.Const;
					break;
				case UCGrammar.UCParser.KW_NATIVE:
					modifiers |= FieldModifiers.Native;
					break;
				case UCGrammar.UCParser.KW_PROTECTED:
					modifiers |= FieldModifiers.Protected;
					break;
				case UCGrammar.UCParser.KW_PRIVATE:
					modifiers |= FieldModifiers.Private;
					break;
			}
		}

		const typeSymbol = this.visitTypeDecl(declTypeNode.typeDecl());
		const varNodes = ctx.variable();
		if (varNodes) for (const varNode of varNodes) {
			const symbol: UCPropertySymbol = varNode.accept(this);
			symbol.type = typeSymbol;
			symbol.modifiers = modifiers;
			this.declare(symbol, varNode);
		}
		return undefined!;
	}

	visitVariable(ctx: UCGrammar.VariableContext) {
		const type = ctx.parent instanceof UCGrammar.LocalDeclContext
			? UCLocalSymbol
			: UCPropertySymbol;

		const identifier: Identifier = idFromCtx(ctx.identifier());
		const symbol: UCPropertySymbol = new type(
			identifier,
			// Stop at varCtx instead of localCtx for multiple variable declarations.
			rangeFromBounds(ctx.parent!.start, ctx.stop)
		);
		symbol.walk(this, ctx);
		return symbol;
	}

	visitStateDecl(ctx: UCGrammar.StateDeclContext) {
		const identifier: Identifier = idFromCtx(ctx.identifier());
		const symbol = new UCStateSymbol(identifier, rangeFromBounds(ctx.start, ctx.stop));

		const extendsNode = ctx.extendsClause();
		if (extendsNode) {
			symbol.extendsType = createQualifiedType(extendsNode._id, UCTypeKind.State);
		}

		this.declare(symbol, ctx);

		this.push(symbol);
		try {
			const memberNodes = ctx.stateMember();
			if (memberNodes) for (const member of memberNodes) {
				member.accept(this);
			}
			symbol.block = blockFromStatementCtx(this, ctx);
		} finally {
			this.pop();
		}
		return symbol;
	}

	visitIgnoresDecl(ctx: UCGrammar.IgnoresDeclContext) {
		const scope = this.scope<UCStateSymbol>();
		if (!scope.ignoreRefs) {
			scope.ignoreRefs = [];
		}
		const idNodes = ctx.identifier();
		for (const idNode of idNodes) {
			const identifier: Identifier = idFromCtx(idNode);
			const ref = new UCSymbolReference(identifier);
			scope.ignoreRefs.push(ref);
		}
		return undefined;
	}

	visitStructDefaultPropertiesBlock(ctx: UCGrammar.StructDefaultPropertiesBlockContext) {
		const identifier: Identifier = {
			name: NAME_DEFAULT,
			range: rangeFromBound(ctx.start)
		};
		const symbol = new UCDefaultPropertiesBlock(identifier, rangeFromBounds(ctx.start, ctx.stop));
		symbol.super = this.scope<UCStructSymbol>();

		this.declare(symbol, ctx);
		this.push(symbol);
		try {
			const statementNodes = ctx.defaultStatement();
			if (statementNodes) {
				const block = new UCBlock(symbol.getRange());
				block.statements = Array(statementNodes.length);
				symbol.block = block;

				let i = 0;
				for (const member of statementNodes) {
					const statement = member.accept(this);

					block.statements[i ++] = statement;
				}
			}
		} finally {
			this.pop();
		}
		return symbol;
	}

	visitDefaultPropertiesBlock(ctx: UCGrammar.DefaultPropertiesBlockContext) {
		const identifier: Identifier = {
			name: NAME_DEFAULT,
			range: rangeFromBound(ctx.start)
		};

		const symbol = new UCDefaultPropertiesBlock(identifier, rangeFromBounds(ctx.start, ctx.stop));
		symbol.super = this.scope<UCStructSymbol>();

		this.declare(symbol, ctx);
		this.push(symbol);
		try {
			const statementNodes = ctx.defaultStatement();
			if (statementNodes) {
				const block = new UCBlock(symbol.getRange());
				block.statements = Array(statementNodes.length);
				symbol.block = block;

				let i = 0;
				for (const member of statementNodes) {
					const statement = member.accept(this);

					block.statements[i ++] = statement;
				}
			}
		} finally {
			this.pop();
			return symbol;
		}
	}

	visitObjectDecl(ctx: UCGrammar.ObjectDeclContext) {
		const id: Identifier = { name: NAME_OBJECT, range: rangeFromBound(ctx.start) };
		const symbol = new UCObjectSymbol(id, rangeFromBounds(ctx.start, ctx.stop));
		symbol.super = this.scope<UCStructSymbol>();
		this.declare(symbol, ctx);
		this.push(symbol);
		try {
			const statementNodes = ctx.defaultStatement();
			if (statementNodes) {
				const block = new UCBlock(symbol.getRange());
				block.statements = Array(statementNodes.length);
				symbol.block = block;

				let i = 0;
				for (const member of statementNodes) {
					const statement = member.accept(this);

					block.statements[i ++] = statement;
				}
			}
		} finally {
			this.pop();
		}

		if (symbol.block && symbol.block.statements) {
			let max = 2;
			for (let i = 0; i < Math.min(symbol.block.statements.length, max); ++ i) {
				const statement = symbol.block.statements[i];
				if (!statement) {
					++ max; // skip, e.g. may have been an objectDecl
					continue;
				}

				// Note: expressions haven't been index yet, so we have to work with raw data.
				if (statement instanceof UCDefaultAssignmentExpression) {
					const symbolName = statement.left instanceof UCMemberExpression
						&& statement.left.getId();

					if (!symbolName) { // not found?
						continue;
					}

					const right = statement.right instanceof UCMemberExpression && statement.right;
					if (!right) {
						continue;
					}

					// TODO: re-assign id with new name and range!, this hower requires us to walk the statements in two phases.
					switch (symbolName) {
						case NAME_NAME:
							symbol.objectName = right.getId();
							break;

						case NAME_CLASS:
							symbol.classId = { name: right.getId(), range: right.getRange() };
							break;

						default:
							console.error("Invalid first variable for an object declaration!");
							break;
					}
				}
			}
		}
		return symbol;
	}

	visitDefaultStatement(ctx: UCGrammar.DefaultStatementContext) {
		const statementNode = ctx.defaultAssignmentExpression();
		if (statementNode) {
			return statementNode.accept(this);
		}

		const objectNode = ctx.objectDecl();
		if (objectNode) {
			objectNode.accept(this);
		}
	}

	visitDefaultLiteral(ctx: UCGrammar.DefaultLiteralContext) {
		return ctx.getChild(0).accept(this);
	}

	visitDefaultAssignmentExpression(ctx: UCGrammar.DefaultAssignmentExpressionContext) {
		const expression = new UCDefaultAssignmentExpression(rangeFromBounds(ctx.start, ctx.stop));

		const primaryNode = ctx.defaultExpression();
		if (primaryNode) {
			expression.left = primaryNode.accept<any>(this);
			expression.left!.outer = expression;
		}

		const exprNode = ctx.defaultLiteral();
		if (exprNode) {
			const rightExpr: IExpression | undefined = exprNode.accept(this);
			if (rightExpr) {
				expression.right = rightExpr;
				expression.right.outer = expression;
			}
		}
		return expression;
	}

	visitDefaultMemberExpression(ctx: UCGrammar.DefaultMemberExpressionContext) {
		return memberFromIdCtx(ctx.identifier());
	}

	visitDefaultPropertyAccessExpression(ctx: UCGrammar.DefaultPropertyAccessExpressionContext) {
		// FIXME: Stub
		return memberFromIdCtx(ctx.identifier());
	}

	visitDefaultElementAccessExpression(ctx: UCGrammar.DefaultElementAccessExpressionContext) {
		// FIXME: Stub
		return memberFromIdCtx(ctx.identifier());
	}

	visitDefaultCallExpression(ctx: UCGrammar.DefaultCallExpressionContext) {
		// FIXME: Stub
		return memberFromIdCtx(ctx.identifier());
	}

	visitExpressionStatement(ctx: UCGrammar.ExpressionStatementContext) {
		const expression: IExpression = ctx.getChild(0).accept<any>(this)!;
		const statement = new UCExpressionStatement(rangeFromBounds(ctx.start, ctx.stop));
		statement.expression = expression;
		return statement;
	}

	visitLabeledStatement(ctx: UCGrammar.LabeledStatementContext): UCLabeledStatement {
		const statement = new UCLabeledStatement(rangeFromBounds(ctx.start, ctx.stop));
		const idNode = ctx.identifier();
		statement.label = toName(idNode.text);
		return statement;
	}

	visitReturnStatement(ctx: UCGrammar.ReturnStatementContext): IStatement {
		const statement = new UCReturnStatement(rangeFromBounds(ctx.start, ctx.stop));

		const exprNode = ctx.expression();
		if (exprNode) {
			statement.expression = exprNode.accept(this);
		}
		return statement;
	}

	visitGotoStatement(ctx: UCGrammar.GotoStatementContext): IStatement {
		const statement = new UCGotoStatement(rangeFromBounds(ctx.start, ctx.stop));

		const exprNode = ctx.expression();
		statement.expression = exprNode.accept(this);
		return statement;
	}

	visitReplicationStatement(ctx: UCGrammar.ReplicationStatementContext): UCIfStatement {
		const statement = new UCIfStatement(rangeFromBounds(ctx.start, ctx.stop));

		const exprNode = ctx.expression();
		if (exprNode) {
			statement.expression = exprNode.accept(this);
		}
		return statement;
	}

	visitWhileStatement(ctx: UCGrammar.WhileStatementContext): UCWhileStatement {
		const statement = new UCWhileStatement(rangeFromBounds(ctx.start, ctx.stop));

		const exprNode = ctx.expression();
		if (exprNode) {
			statement.expression = exprNode.accept(this);
		}

		const blockNode = ctx.codeBlockOptional();
		statement.then = blockFromStatementCtx(this, blockNode);
		return statement;
	}

	visitIfStatement(ctx: UCGrammar.IfStatementContext): UCIfStatement {
		const statement = new UCIfStatement(rangeFromBounds(ctx.start, ctx.stop));

		const exprNode = ctx.expression();
		if (exprNode) {
			statement.expression = exprNode.accept(this);
		}

		const blockNode = ctx.codeBlockOptional();
		statement.then = blockFromStatementCtx(this, blockNode);

		const elseStatementNode = ctx.elseStatement();
		if (elseStatementNode) {
			statement.else = elseStatementNode.accept(this);
		}
		return statement;
	}

	visitElseStatement(ctx: UCGrammar.ElseStatementContext) {
		const blockNode = ctx.codeBlockOptional();
		return blockFromStatementCtx(this, blockNode);
	}

	visitDoStatement(ctx: UCGrammar.DoStatementContext): UCDoUntilStatement {
		const statement = new UCDoUntilStatement(rangeFromBounds(ctx.start, ctx.stop));

		const exprNode = ctx.expression();
		if (exprNode) {
			statement.expression = exprNode.accept(this);
		}

		const blockNode = ctx.codeBlockOptional();
		statement.then = blockFromStatementCtx(this, blockNode);
		return statement;
	}

	visitForeachStatement(ctx: UCGrammar.ForeachStatementContext): UCForEachStatement {
		const statement = new UCForEachStatement(rangeFromBounds(ctx.start, ctx.stop));

		const exprNode = ctx.primaryExpression();
		if (exprNode) {
			statement.expression = exprNode.accept<any>(this);
		}

		const blockNode = ctx.codeBlockOptional();
		statement.then = blockFromStatementCtx(this, blockNode);
		return statement;
	}

	visitForStatement(ctx: UCGrammar.ForStatementContext): UCForStatement {
		const statement = new UCForStatement(rangeFromBounds(ctx.start, ctx.stop));

		if (ctx._initExpr) {
			statement.init = ctx._initExpr.accept(this);
		}

		// Not really a valid expression with an assignment, but this is done this way for our convenience.
		// TODO: Obviously check if type can be resolved to a boolean!
		if (ctx._condExpr) {
			statement.expression = ctx._condExpr.accept(this);
		}

		if (ctx._nextExpr) {
			statement.next = ctx._nextExpr.accept(this);
		}

		const blockNode = ctx.codeBlockOptional();
		statement.then = blockFromStatementCtx(this, blockNode);
		return statement;
	}

	visitSwitchStatement(ctx: UCGrammar.SwitchStatementContext): IStatement {
		const statement = new UCSwitchStatement(rangeFromBounds(ctx.start, ctx.stop));

		const exprNode = ctx.expression();
		if (exprNode) {
			statement.expression = exprNode.accept(this);
		}

		const clauseNodes: ParserRuleContext[] = ctx.caseClause() || [];
		const defaultClauseNode = ctx.defaultClause();

		if (defaultClauseNode) {
			clauseNodes.push(defaultClauseNode);
		}

		const block = new UCBlock(rangeFromBounds(ctx.start, ctx.stop));
		block.statements = Array(clauseNodes.length);
		for (let i = 0; i < clauseNodes.length; ++i) {
			const caseStatement: IStatement = clauseNodes[i].accept<any>(this);
			block.statements[i] = caseStatement;
		}
		statement.then = block;

		return statement;
	}

	visitCaseClause(ctx: UCGrammar.CaseClauseContext): IStatement {
		const statement = new UCCaseClause(rangeFromBounds(ctx.start, ctx.stop));

		const exprNode = ctx.expression();
		if (exprNode) {
			statement.expression = exprNode.accept(this);
		}
		statement.then = blockFromStatementCtx(this, ctx);
		return statement;
	}

	visitDefaultClause(ctx: UCGrammar.DefaultClauseContext) {
		const statement = new UCDefaultClause(rangeFromBounds(ctx.start, ctx.stop));
		statement.then = blockFromStatementCtx(this, ctx);
		return statement;
	}

	visitAssertStatement(ctx: UCGrammar.AssertStatementContext): IStatement {
		const statement = new UCAssertStatement(rangeFromBounds(ctx.start, ctx.stop));

		const exprNode = ctx.expression();
		if (exprNode) {
			statement.expression = exprNode.accept(this);
		}
		return statement;
	}

	visitAssignmentExpression(ctx: UCGrammar.AssignmentExpressionContext) {
		const expression = new UCAssignmentOperatorExpression(rangeFromBounds(ctx.start, ctx.stop));

		const operatorNode = ctx._id;
		const identifier: Identifier = {
			name: toName(operatorNode.text!),
			range: rangeFromBound(operatorNode)
		};

		if (operatorNode.text !== '=') {
			expression.operator = new UCSymbolReference(identifier);
		}

		const primaryNode = ctx._left;
		expression.left = primaryNode.accept<any>(this);
		expression.left!.outer = expression;

		const exprNode = ctx._right;
		if (exprNode) {
			expression.right = exprNode.accept<any>(this);
			expression.right!.outer = expression;
		} else {
			this.document.nodes.push(new SyntaxErrorNode(identifier.range, "Expression expected."));
		}

		return expression;
	}

	visitConditionalExpression(ctx: UCGrammar.ConditionalExpressionContext) {
		const expression = new UCConditionalExpression(rangeFromBounds(ctx.start, ctx.stop));

		const conditionNode = ctx._cond;
		if (conditionNode) {
			expression.condition = conditionNode.accept<any>(this);
			expression.condition.outer = expression;
		}

		const leftNode = ctx._left;
		if (leftNode) {
			expression.true = leftNode.accept<any>(this);
			expression.true!.outer = expression;
		}

		const rightNode = ctx._right;
		if (rightNode) {
			expression.false = rightNode.accept<any>(this);
			expression.false!.outer = expression;
		}
		return expression;
	}

	visitBinaryOperatorExpression(ctx: UCGrammar.BinaryOperatorExpressionContext) {
		const expression = new UCBinaryOperatorExpression(rangeFromBounds(ctx.start, ctx.stop));

		const leftNode = ctx._left;
		if (leftNode) {
			expression.left = leftNode.accept<any>(this);
			expression.left!.outer = expression;
		}

		const operatorNode = ctx._id;
		const identifier: Identifier = {
			name: toName(operatorNode.text!),
			range: rangeFromBound(operatorNode)
		};
		expression.operator = new UCSymbolReference(identifier);

		const rightNode = ctx._right;
		if (rightNode) {
			expression.right = rightNode.accept<any>(this);
			expression.right!.outer = expression;
		} else {
			this.document.nodes.push(new SyntaxErrorNode(rangeFromBound(operatorNode), "Expression expected."));
		}
		return expression;
	}

	visitBinaryNamedOperatorExpression(ctx: UCGrammar.BinaryNamedOperatorExpressionContext) {
		const expression = new UCBinaryOperatorExpression(rangeFromBounds(ctx.start, ctx.stop));

		const leftNode = ctx._left;
		if (leftNode) {
			expression.left = leftNode.accept<any>(this);
			expression.left!.outer = expression;
		}

		const operatorNode = ctx._id;
		const identifier = idFromToken(operatorNode);
		expression.operator = new UCSymbolReference(identifier);

		const rightNode = ctx._right;
		if (rightNode) {
			expression.right = rightNode.accept<any>(this);
			expression.right!.outer = expression;
		} else {
			this.document.nodes.push(new SyntaxErrorNode(identifier.range, "Expression expected."));
		}
		return expression;
	}

	visitPostOperatorExpression(ctx: UCGrammar.PostOperatorExpressionContext) {
		const expression = new UCPostOperatorExpression(rangeFromBounds(ctx.start, ctx.stop));

		const primaryNode = ctx._left;
		expression.expression = primaryNode.accept<any>(this);
		expression.expression.outer = expression;

		const operatorNode = ctx._id;
		const identifier: Identifier = {
			name: toName(operatorNode.text!),
			range: rangeFromBound(operatorNode)
		};
		expression.operator = new UCSymbolReference(identifier);
		return expression;
	}

	visitPreOperatorExpression(ctx: UCGrammar.PreOperatorExpressionContext) {
		const expression = new UCPreOperatorExpression(rangeFromBounds(ctx.start, ctx.stop));

		const primaryNode = ctx._right;
		expression.expression = primaryNode.accept<any>(this);
		expression.expression.outer = expression;

		const operatorNode = ctx._id;
		const identifier: Identifier = {
			name: toName(operatorNode.text!),
			range: rangeFromBound(operatorNode)
		};
		expression.operator = new UCSymbolReference(identifier);
		return expression;
	}

	// visitPostNamedOperatorExpression(ctx: UCGrammar.PostNamedOperatorExpressionContext) {
	// 	const expression = new UCPostOperatorExpression();

	// 	const primaryNode = ctx._left;
	// 	expression.expression = primaryNode.accept<any>(this);
	// 	expression.expression.outer = expression;

	// 	const operatorNode = ctx._id;
	// 	expression.operator = new UCSymbolReference(createIdentifierFrom(operatorNode));
	// 	return expression;
	// }

	// visitPreNamedOperatorExpression(ctx: UCGrammar.PreNamedOperatorExpressionContext) {
	// 	const expression = new UCPreOperatorExpression();

	// 	const primaryNode = ctx._right;
	// 	expression.expression = primaryNode.accept<any>(this);
	// 	expression.expression.outer = expression;

	// 	const operatorNode = ctx._id;
	// 	expression.operator = new UCSymbolReference(createIdentifierFrom(operatorNode));
	// 	return expression;
	// }

	visitParenthesizedExpression(ctx: UCGrammar.ParenthesizedExpressionContext) {
		const expression = new UCParenthesizedExpression(rangeFromBounds(ctx.start, ctx.stop));

		const exprNode = ctx.expression();
		if (exprNode) {
			expression.expression = exprNode.accept<any>(this);
			expression.expression!.outer = expression;
		}
		return expression;
	}

	visitPropertyAccessExpression(ctx: UCGrammar.PropertyAccessExpressionContext) {
		const expression = new UCPropertyAccessExpression(rangeFromBounds(ctx.start, ctx.stop));

		const primaryNode = ctx.primaryExpression();
		if (primaryNode) {
			expression.left = primaryNode.accept<any>(this);
			expression.left!.outer = expression;
		}

		const idNode = ctx.identifier();
		expression.member = memberFromIdCtx(idNode);
		expression.member.outer = expression;
		return expression;

		// const specNode = ctx.classPropertyAccessSpecifier();
		// if (specNode) {
		// 	// TODO: recognize this particular kind of a propertyAccessExpression
		// }
	}

	visitMemberExpression(ctx: UCGrammar.MemberExpressionContext) {
		return memberFromIdCtx(ctx.identifier());
	}

	visitCallExpression(ctx: UCGrammar.CallExpressionContext) {
		const expression = new UCCallExpression(rangeFromBounds(ctx.start, ctx.stop));

		// expr ( arguments )
		const exprNode = ctx.primaryExpression();
		if (exprNode) {
			expression.expression = exprNode.accept<any>(this);
			expression.expression!.outer = expression;
		}

		const exprArgumentNodes = ctx.arguments();
		if (exprArgumentNodes) {
			expression.arguments = exprArgumentNodes.accept(this);
			if (expression.arguments) for (let i = 0; i < expression.arguments.length; ++i) {
				if (expression.arguments[i]) {
					expression.arguments[i]!.outer = expression;
				}
			}
		}
		return expression;
	}

	visitArguments(ctx: UCGrammar.ArgumentsContext): IExpression[] | undefined {
		const argumentNodes = ctx.argument();
		if (!argumentNodes) {
			return undefined;
		}

		const exprArgs = new Array(argumentNodes.length);
		for (let i = 0; i < exprArgs.length; ++i) {
			exprArgs[i] = argumentNodes[i].accept(this);
		}
		return exprArgs;
	}

	visitArgument(ctx: UCGrammar.ArgumentContext): IExpression | undefined {
		const exprNode = ctx.expression();
		if (exprNode) {
			return exprNode.accept(this);
		}
		return undefined;
	}

	// primaryExpression [ expression ]
	visitElementAccessExpression(ctx: UCGrammar.ElementAccessExpressionContext) {
		const expression = new UCElementAccessExpression(rangeFromBounds(ctx.start, ctx.stop));

		const primaryNode = ctx.primaryExpression();
		if (primaryNode) {
			expression.expression = primaryNode.accept<any>(this);
			expression.expression!.outer = expression;
		}

		const exprNode = ctx.expression();
		if (exprNode) {
			expression.argument = exprNode.accept<any>(this);
			expression.argument!.outer = expression;
		}
		return expression;
	}

	// new ( arguments ) classArgument
	visitNewExpression(ctx: UCGrammar.NewExpressionContext) {
		const expression = new UCNewExpression(rangeFromBounds(ctx.start, ctx.stop));

		const exprNode = ctx.primaryExpression();
		if (exprNode) {
			expression.expression = exprNode.accept<any>(this);
			expression.expression!.outer = expression;
		}

		const exprArgumentNodes = ctx.arguments();
		if (exprArgumentNodes) {
			expression.arguments = exprArgumentNodes.accept(this);
			if (expression.arguments) for (let i = 0; i < expression.arguments.length; ++i) {
				if (expression.arguments[i]) {
					expression.arguments[i]!.outer = expression;
				}
			}
		}
		return expression;
	}

	visitMetaClassExpression(ctx: UCGrammar.MetaClassExpressionContext) {
		const expression = new UCMetaClassExpression(rangeFromBounds(ctx.start, ctx.stop));

		const classIdNode = ctx.identifier();
		if (classIdNode) {
			expression.classRef = new UCObjectTypeSymbol(idFromCtx(classIdNode), undefined, UCTypeKind.Class);
		}

		const exprNode = ctx.expression();
		if (exprNode) {
			expression.expression = exprNode.accept(this);
			expression.expression!.outer = expression;
		}
		return expression;
	}

	visitSuperExpression(ctx: UCGrammar.SuperExpressionContext) {
		const range = rangeFromBounds(ctx.start, ctx.stop);
		const expression = new UCSuperExpression(range);

		const superIdNode = ctx.identifier();
		if (superIdNode) {
			expression.structRef = new UCSymbolReference(idFromCtx(superIdNode));
		}
		return expression;
	}

	visitSelfReferenceExpression(ctx: UCGrammar.SelfReferenceExpressionContext) {
		const expression = new UCPredefinedAccessExpression(new UCSymbolReference(idFromCtx(ctx)));
		return expression;
	}

	visitDefaultReferenceExpression(ctx: UCGrammar.DefaultReferenceExpressionContext) {
		const expression = new UCPredefinedAccessExpression(new UCSymbolReference(idFromCtx(ctx)));
		return expression;
	}

	visitStaticAccessExpression(ctx: UCGrammar.StaticAccessExpressionContext) {
		const expression = new UCPredefinedAccessExpression(new UCSymbolReference(idFromCtx(ctx)));
		return expression;
	}

	visitGlobalAccessExpression(ctx: UCGrammar.GlobalAccessExpressionContext) {
		const expression = new UCPredefinedAccessExpression(new UCSymbolReference(idFromCtx(ctx)));
		return expression;
	}

	visitClassPropertyAccessSpecifier(ctx: UCGrammar.ClassPropertyAccessSpecifierContext) {
		const expression = new UCPredefinedPropertyAccessExpression(new UCSymbolReference(idFromCtx(ctx)));
		return expression;
	}

	visitArrayCountExpression(ctx: UCGrammar.ArrayCountExpressionContext) {
		const expression = new UCArrayCountExpression(rangeFromBounds(ctx.start, ctx.stop));

		const exprNode = ctx.primaryExpression();
		if (exprNode) {
			expression.expression = exprNode.accept<any>(this);
			expression.expression!.outer = expression;
		}
		return expression;
	}

	visitArrayCountToken(ctx: UCGrammar.ArrayCountTokenContext) {
		const range = rangeFromBounds(ctx.start, ctx.stop);
		const expression = new UCArrayCountLiteral(range);

		const idNode = ctx.identifier();
		if (idNode) {
			const identifier: Identifier = idFromCtx(idNode);
			expression.argumentRef = new UCObjectTypeSymbol(identifier, undefined, UCTypeKind.Property);
		}

		return expression;
	}

	visitSizeOfToken(ctx: UCGrammar.SizeOfTokenContext) {
		const range = rangeFromBounds(ctx.start, ctx.stop);
		const expression = new UCSizeOfLiteral(range);

		const idNode = ctx.identifier();
		if (idNode) {
			const identifier: Identifier = idFromCtx(idNode);
			expression.argumentRef = new UCObjectTypeSymbol(identifier, undefined, UCTypeKind.Class);
		}

		return expression;
	}

	visitNoneLiteral(ctx: UCGrammar.NoneLiteralContext) {
		const range = rangeFromBounds(ctx.start, ctx.stop);
		const expression = new UCNoneLiteral(range);
		return expression;
	}

	visitStringLiteral(ctx: UCGrammar.StringLiteralContext) {
		const range = rangeFromBounds(ctx.start, ctx.stop);
		const expression = new UCStringLiteral(range);
		return expression;
	}

	visitNameLiteral(ctx: UCGrammar.NameLiteralContext) {
		const range = rangeFromBounds(ctx.start, ctx.stop);
		const expression = new UCNameLiteral(range);
		return expression;
	}

	visitBoolLiteral(ctx: UCGrammar.BoolLiteralContext) {
		const range = rangeFromBounds(ctx.start, ctx.stop);
		const expression = new UCBoolLiteral(range);
		return expression;
	}

	visitFloatLiteral(ctx: UCGrammar.FloatLiteralContext) {
		const range = rangeFromBounds(ctx.start, ctx.stop);
		const expression = new UCFloatLiteral(range);
		expression.value = Number.parseFloat(ctx.FLOAT().text);
		return expression;
	}

	visitNumberLiteral(ctx: UCGrammar.NumberLiteralContext) {
		const range = rangeFromBounds(ctx.start, ctx.stop);
		const expression = new UCFloatLiteral(range);
		expression.value = Number.parseFloat(ctx.text);
		return expression;
	}

	visitIntLiteral(ctx: UCGrammar.IntLiteralContext) {
		const rawValue = Number.parseInt(ctx.INTEGER().text);
		const range = rangeFromBounds(ctx.start, ctx.stop);
		const expression = new ((rawValue >= 0 && rawValue <= 255) ? UCByteLiteral : UCIntLiteral)(range);
		expression.value = rawValue;
		return expression;
	}

	visitObjectLiteral(ctx: UCGrammar.ObjectLiteralContext) {
		const expression = new UCObjectLiteral(rangeFromBounds(ctx.start, ctx.stop));

		const classIdNode = ctx.identifier();
		const castRef = new UCSymbolReference(idFromCtx(classIdNode));
		expression.castRef = castRef;

		const objectIdNode = ctx.NAME();
		const str = objectIdNode.text.replace(/'|\s/g, "");
		const ids = str.split('.');

		const startLine = objectIdNode.symbol.line - 1;
		let startChar = objectIdNode.symbol.charPositionInLine + 1;

		const identifiers: Identifier[] = [];
		for (const id of ids) {
			const identifier: Identifier = {
				name: toName(id),
				range: {
					start: {
						line: startLine,
						character: startChar
					},
					end: {
						line: startLine,
						character: startChar + id.length
					}
				} as Range
			};
			identifiers.push(identifier);

			startChar += id.length + 1;
		}

		const type = typeFromIds(identifiers);
		if (type) {
			expression.objectRef = type;
		}
		return expression;
	}

	visitStructLiteral(ctx: UCGrammar.StructLiteralContext) {
		const range = rangeFromBounds(ctx.start, ctx.stop);
		const expression = new UCDefaultStructLiteral(range);

		// FIXME: Assign structType

		return expression;
	}

	visitQualifiedIdentifierLiteral(ctx: UCGrammar.QualifiedIdentifierLiteralContext) {
		// TODO: Support
		return undefined;
	}

	visitIdentifierLiteral(ctx: UCGrammar.IdentifierLiteralContext) {
		const expression = memberFromIdCtx(ctx.identifier());
		return expression;
	}

	visitVectToken(ctx: UCGrammar.VectTokenContext) {
		const range = rangeFromBounds(ctx.start, ctx.stop);
		const expression = new UCVectLiteral(range);
		return expression;
	}

	visitRotToken(ctx: UCGrammar.RotTokenContext) {
		const range = rangeFromBounds(ctx.start, ctx.stop);
		const expression = new UCRotLiteral(range);
		return expression;
	}

	visitRngToken(ctx: UCGrammar.RngTokenContext) {
		const range = rangeFromBounds(ctx.start, ctx.stop);
		const expression = new UCRngLiteral(range);
		return expression;
	}

	visitNameOfToken(ctx: UCGrammar.NameOfTokenContext) {
		const range = rangeFromBounds(ctx.start, ctx.stop);
		const expression = new UCNameOfLiteral(range);
		const idNode = ctx.identifier();
		if (idNode) {
			expression.argumentRef = new UCObjectTypeSymbol(idFromCtx(idNode), undefined, UCTypeKind.Object);
		}
		return expression;
	}

	protected defaultResult() {
		return undefined;
	}
}