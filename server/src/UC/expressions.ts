import { Position, Range } from 'vscode-languageserver';

import { UnrecognizedFieldNode, UnrecognizedTypeNode, SemanticErrorNode, ExpressionErrorNode } from './diagnostics/diagnostic';
import { getEnumMember } from './indexer';
import { intersectsWith } from './helpers';
import { UCDocument } from './document';
import { Name } from './names';

import {
	ISymbol, UCSymbol,
	UCObjectTypeSymbol, UCStructSymbol,
	UCPropertySymbol, UCSymbolReference,
	UCMethodSymbol, UCClassSymbol, UCEnumSymbol,
	NativeArray, NativeClass, NativeEnum,
	VectorTypeRef, VectMethodLike,
	RotatorTypeRef, RotMethodLike,
	RangeTypeRef, RngMethodLike,
	ITypeSymbol, TypeCastMap, UCTypeKind,
	UCDelegateSymbol, UCStateSymbol,
	analyzeTypeSymbol, ClassesTable, ObjectsTable, findSuperStruct
} from './Symbols';
import { SymbolWalker } from './symbolWalker';

export interface IExpression {
	outer: IExpression;

	getRange(): Range;

	getMemberSymbol(): ISymbol | undefined;
	getTypeKind(): UCTypeKind;

	getSymbolAtPos(position: Position): ISymbol | undefined;

	index(document: UCDocument, context?: UCStructSymbol): void;
	analyze(document: UCDocument, context?: UCStructSymbol): void;

	accept<Result>(visitor: SymbolWalker<Result>): Result;
}

export abstract class UCExpression implements IExpression {
	outer: IExpression;

	constructor(protected range: Range) {
	}

	getRange(): Range {
		return this.range;
	}

	getMemberSymbol(): ISymbol | undefined {
		return undefined;
	}

	getTypeKind(): UCTypeKind {
		return UCTypeKind.Error;
	}

	getSymbolAtPos(position: Position): ISymbol | undefined {
		if (!intersectsWith(this.getRange(), position)) {
			return undefined;
		}
		const symbol = this.getContainedSymbolAtPos(position);
		return symbol;
	}

	abstract getContainedSymbolAtPos(position: Position): ISymbol | undefined;
	abstract index(document: UCDocument, context?: UCStructSymbol): void;
	analyze(_document: UCDocument, _context?: UCStructSymbol): void {}

	accept<Result>(visitor: SymbolWalker<Result>): Result {
		return visitor.visitExpression(this);
	}
}

export class UCParenthesizedExpression extends UCExpression {
	public expression?: IExpression;

	getMemberSymbol() {
		return this.expression && this.expression.getMemberSymbol();
	}

	getTypeKind(): UCTypeKind {
		return this.expression && this.expression.getTypeKind() || UCTypeKind.Error;
	}

	getContainedSymbolAtPos(position: Position) {
		const symbol = this.expression && this.expression.getSymbolAtPos(position);
		return symbol;
	}

	index(document: UCDocument, context?: UCStructSymbol) {
		if (this.expression) this.expression.index(document, context);
	}

	analyze(document: UCDocument, context?: UCStructSymbol) {
		if (this.expression) this.expression.analyze(document, context);
	}
}

export class UCArrayCountExpression extends UCParenthesizedExpression {

}

export class UCCallExpression extends UCExpression {
	public expression?: IExpression;
	public arguments?: Array<IExpression | undefined>;

	getMemberSymbol() {
		return this.expression && this.expression.getMemberSymbol();
	}

	getTypeKind(): UCTypeKind {
		return this.expression && this.expression.getTypeKind() || UCTypeKind.Error;
	}

	getContainedSymbolAtPos(position: Position) {
		if (this.expression) {
			const symbol = this.expression.getSymbolAtPos(position);
			if (symbol) {
				return symbol;
			}
		}

		if (this.arguments) for (const arg of this.arguments) {
			const symbol = arg && arg.getSymbolAtPos(position);
			if (symbol) {
				return symbol;
			}
		}
	}

	index(document: UCDocument, context?: UCStructSymbol) {
		if (this.expression) this.expression.index(document, context);
		if (this.arguments) for (const arg of this.arguments) {
			arg && arg.index(document, context);
		}
	}

	analyze(document: UCDocument, context?: UCStructSymbol) {
		if (this.expression) this.expression.analyze(document, context);
		if (this.arguments) for (const arg of this.arguments) {
			arg && arg.analyze(document, context);
		}
	}
}

export class UCElementAccessExpression extends UCExpression {
	public expression?: IExpression;
	public argument?: IExpression;

	getMemberSymbol() {
		const symbol = this.expression && this.expression.getMemberSymbol();

		// Try to resolve to the referred symbol's defined type.
		if (symbol instanceof UCPropertySymbol) {
			if (!symbol.type) return undefined;

			if (symbol.type instanceof UCObjectTypeSymbol && symbol.type.baseType) {
				return symbol.type.baseType.getReference() as UCStructSymbol;
			}
			return symbol.type.getReference() as UCStructSymbol;
		}

		if (symbol instanceof UCMethodSymbol) {
			if (!symbol.returnType) return undefined;

			if (symbol.returnType instanceof UCObjectTypeSymbol && symbol.returnType.baseType) {
				return symbol.returnType.baseType.getReference() as UCStructSymbol;
			}
			return symbol.returnType.getReference() as UCStructSymbol;
		}
		return symbol;
	}

	getTypeKind(): UCTypeKind {
		return this.expression && this.expression.getTypeKind() || UCTypeKind.Error;
	}

	getContainedSymbolAtPos(position: Position) {
		if (this.expression) {
			const symbol = this.expression.getSymbolAtPos(position);
			if (symbol) {
				return symbol;
			}
		}

		if (this.argument) {
			const symbol = this.argument.getSymbolAtPos(position);
			if (symbol) {
				return symbol;
			}
		}
	}

	index(document: UCDocument, context?: UCStructSymbol) {
		if (this.expression) this.expression.index(document, context);
		if (this.argument) this.argument.index(document, context);
	}

	analyze(document: UCDocument, context?: UCStructSymbol) {
		if (this.expression) this.expression.analyze(document, context);
		if (this.argument) this.argument.analyze(document, context);
	}
}

export class UCPropertyAccessExpression extends UCExpression {
	public left?: IExpression;
	public member?: UCMemberExpression;

	getMemberSymbol() {
		return this.member && this.member.getMemberSymbol();
	}

	getTypeKind(): UCTypeKind {
		return this.member && this.member.getTypeKind() || UCTypeKind.Error;
	}

	getContainedSymbolAtPos(position: Position) {
		if (this.left) {
			const symbol = this.left.getSymbolAtPos(position);
			if (symbol) {
				return symbol;
			}
		}

		if (this.member) {
			const symbol = this.member.getSymbolAtPos(position);
			if (symbol) {
				return symbol;
			}
		}
	}

	index(document: UCDocument, context?: UCStructSymbol) {
		if (this.left) this.left.index(document, context);

		const memberContext = this.getContextType();
		if (this.member && memberContext instanceof UCStructSymbol) {
			this.member.index(document, memberContext);
		}
	}

	analyze(document: UCDocument, context?: UCStructSymbol) {
		if (this.left) this.left.analyze(document, context);

		const memberContext = this.getContextType();
		if (this.member) {
			this.member.analyze(document, memberContext as UCStructSymbol);
		}
	}

	getContextType(): ISymbol | undefined {
		const symbol = this.left && this.left.getMemberSymbol();
		if (!symbol) {
			return undefined;
		}

		// Resolve properties to its defined type
		// e.g. given property "local array<Vector> Foo;"
		// -- will be resolved to array or Vector (in an index expression, handled elsewhere).
		if (symbol instanceof UCPropertySymbol) {
			if (symbol.type) {
				return ((symbol.type.getReference() !== NativeArray && symbol.type instanceof UCObjectTypeSymbol && symbol.type.baseType)
					? symbol.type.baseType.getReference()
					: symbol.type.getReference());
			}
			return undefined;
		}
		if (symbol instanceof UCMethodSymbol) {
			if (symbol.returnType) {
				return (symbol.returnType instanceof UCObjectTypeSymbol && symbol.returnType.baseType
					? symbol.returnType.baseType.getReference()
					: symbol.returnType.getReference());
			}
			return undefined;
		}
		return symbol;
	}
}

export class UCConditionalExpression extends UCExpression {
	public condition: IExpression;
	public true?: IExpression;
	public false?: IExpression;

	getMemberSymbol() {
		return (this.true && this.true.getMemberSymbol()) || (this.false && this.false.getMemberSymbol());
	}

	getTypeKind(): UCTypeKind {
		return this.true && this.true.getTypeKind() || UCTypeKind.Error;
	}

	getContainedSymbolAtPos(position: Position) {
		if (this.condition) {
			const symbol = this.condition.getSymbolAtPos(position);
			if (symbol) {
				return symbol;
			}
		}

		if (this.true) {
			const symbol = this.true.getSymbolAtPos(position);
			if (symbol) {
				return symbol;
			}
		}

		if (this.false) {
			const symbol = this.false.getSymbolAtPos(position);
			if (symbol) {
				return symbol;
			}
		}
	}

	index(document: UCDocument, context?: UCStructSymbol) {
		if (this.condition) this.condition.index(document, context);
		if (this.true) this.true.index(document, context);
		if (this.false) this.false.index(document, context);
	}

	analyze(document: UCDocument, context?: UCStructSymbol) {
		if (this.condition) this.condition.analyze(document, context);
		if (this.true) this.true.analyze(document, context);
		if (this.false) this.false.analyze(document, context);
	}
}

// TODO: What about UCState? Can states properly declare operators?
function findOperatorSymbol(id: Name, context: UCStructSymbol): UCSymbol | undefined {
	let scope = context instanceof UCMethodSymbol ? context.outer : context;
	if (scope instanceof UCStateSymbol) {
		scope = scope.outer;
	}
	for (; scope instanceof UCStructSymbol; scope = scope.super) {
		for (let child = scope.children; child; child = child.next) {
			if (child.getId() === id) {
				if (child instanceof UCMethodSymbol && child.isOperator()) {
					return child;
				}
			}
		}
	}
}

function findPreOperatorSymbol(id: Name, context: UCStructSymbol): UCSymbol | undefined {
	let scope = context instanceof UCMethodSymbol ? context.outer : context;
	if (scope instanceof UCStateSymbol) {
		scope = scope.outer;
	}
	for (; scope instanceof UCStructSymbol; scope = scope.super) {
		for (let child = scope.children; child; child = child.next) {
			if (child.getId() === id) {
				if (child instanceof UCMethodSymbol && child.isPreOperator()) {
					return child;
				}
			}
		}
	}
}

function findPostOperatorSymbol(id: Name, context: UCStructSymbol): UCSymbol | undefined {
	let scope = context instanceof UCMethodSymbol ? context.outer : context;
	if (scope instanceof UCStateSymbol) {
		scope = scope.outer;
	}
	for (; scope instanceof UCStructSymbol; scope = scope.super) {
		for (let child = scope.children; child; child = child.next) {
			if (child.getId() === id) {
				if (child instanceof UCMethodSymbol && child.isPostOperator()) {
					return child;
				}
			}
		}
	}
}

abstract class UCBaseOperatorExpression extends UCExpression {
	public expression: IExpression;
	public operator?: UCSymbolReference;

	getMemberSymbol() {
		return this.expression.getMemberSymbol();
	}

	getTypeKind(): UCTypeKind {
		return this.operator ? this.operator.getTypeKind() : UCTypeKind.Error;
	}

	getContainedSymbolAtPos(position: Position) {
		const symbol = this.operator && this.operator.getSymbolAtPos(position);
		if (symbol && this.operator!.getReference()) {
			return symbol;
		}
		return this.expression && this.expression.getSymbolAtPos(position);
	}

	index(document: UCDocument, context: UCStructSymbol) {
		if (this.expression) this.expression.index(document, context);
	}

	analyze(document: UCDocument, context?: UCStructSymbol) {
		if (this.expression) this.expression.analyze(document, context);
	}
}

export class UCPostOperatorExpression extends UCBaseOperatorExpression {
	index(document: UCDocument, context: UCStructSymbol) {
		super.index(document, context);
		if (this.operator) {
			const operatorSymbol = findPostOperatorSymbol(this.operator.getId(), context);
			operatorSymbol && this.operator.setReference(operatorSymbol, document);
		}
	}

	analyze(document: UCDocument, context?: UCStructSymbol) {
		super.analyze(document, context);
		if (this.operator) {
			const operatorSymbol = this.operator.getReference();
			if (!operatorSymbol) {
				document.nodes.push(new SemanticErrorNode(this.operator, `Invalid postoperator '${this.operator.getId()}'.`));
			}
		}
	}
}

export class UCPreOperatorExpression extends UCBaseOperatorExpression {
	index(document: UCDocument, context: UCStructSymbol) {
		super.index(document, context);
		if (this.operator) {
			const operatorSymbol = findPreOperatorSymbol(this.operator.getId(), context);
			operatorSymbol && this.operator.setReference(operatorSymbol, document);
		}
	}

	analyze(document: UCDocument, context?: UCStructSymbol) {
		super.analyze(document, context);
		if (this.operator) {
			const operatorSymbol = this.operator.getReference();
			if (!operatorSymbol) {
				document.nodes.push(new SemanticErrorNode(this.operator, `Invalid preoperator '${this.operator.getId()}'.`));
			}
		}
	}
}

// TODO: Index and match overloaded operators.
export class UCBinaryOperatorExpression extends UCExpression {
	public left?: IExpression;
	public operator?: UCSymbolReference;
	public right?: IExpression;

	getMemberSymbol() {
		// TODO: Return the operator's return type.
		return (this.left && this.left.getMemberSymbol()) || (this.right && this.right.getMemberSymbol());
	}

	getTypeKind(): UCTypeKind {
		// TODO: requires proper overloaded operator linking, then should return the type of the operator.
		return this.operator!.getTypeKind();
	}

	getContainedSymbolAtPos(position: Position) {
		const symbol = this.operator && this.operator.getSymbolAtPos(position);
		if (symbol && this.operator!.getReference()) {
			return symbol;
		}

		if (this.left) {
			const symbol = this.left.getSymbolAtPos(position);
			if (symbol) {
				return symbol;
			}
		}

		if (this.right) {
			const symbol = this.right.getSymbolAtPos(position);
			if (symbol) {
				return symbol;
			}
		}
	}

	index(document: UCDocument, context?: UCStructSymbol) {
		if (this.operator) {
			// Because we only need to match operators, we can directly skip @context and look in the upper class.
			const operatorSymbol = findOperatorSymbol(this.operator.getId(), context!);
			operatorSymbol && this.operator.setReference(operatorSymbol, document);
		}

		if (this.left) this.left.index(document, context);
		if (this.right) this.right.index(document, context);
	}

	analyze(document: UCDocument, context?: UCStructSymbol) {
		if (this.left) this.left.analyze(document, context);
		if (this.right) this.right.analyze(document, context);

		if (this.operator) {
			const operatorSymbol = this.operator.getReference();
			if (!operatorSymbol) {
				document.nodes.push(new SemanticErrorNode(this.operator, `Invalid operator '${this.operator.getId()}'.`));
			}
		}
	}
}

export class UCAssignmentExpression extends UCBinaryOperatorExpression {
	getTypeKind(): UCTypeKind {
		return UCTypeKind.Error;
	}

	analyze(document: UCDocument, context?: UCStructSymbol) {
		super.analyze(document, context);

		// TODO: Validate type compatibility, but this requires us to match an overloaded operator first!
		if (!this.left) {
			document.nodes.push(new ExpressionErrorNode(this, "Missing left expression!"));
			return;
		}

		const letType = this.left.getTypeKind();
		const letSymbol = this.left.getMemberSymbol();
		if (letSymbol) {
			if (letSymbol instanceof UCPropertySymbol) {
				// Properties with a defined array dimension cannot be assigned!
				if (letSymbol.isFixedArray()) {
					document.nodes.push(new SemanticErrorNode(letSymbol, "Cannot assign to a static array variable."));
				}

				if (letSymbol.isConst()) {
					document.nodes.push(new SemanticErrorNode(letSymbol, "Cannot assign to a constant variable."));
				}
			} else if (letSymbol instanceof UCMethodSymbol) {
				// TODO: Distinguish a delegate from a regular method!
				// TODO: throw error unless it's a delegate.
			} else {
				// AN ElementAccessExpression does not return the property but its type that's being assigned, in this case such assignments are legal.
				// -- but elsewhere, assigning a type is illegal!
				if (this.left instanceof UCElementAccessExpression) {

				} else {
					document.nodes.push(new ExpressionErrorNode(this.left!, `Cannot assign to expression (type: '${UCTypeKind[letType]}'), because it is not a variable.`));
				}
			}
		} else {
			if (letType === UCTypeKind.Object) {
				// TODO:
			}
			else {
				document.nodes.push(new ExpressionErrorNode(this.left!, `Cannot assign to expression (type: '${UCTypeKind[letType]}'), because it is not a variable.`));
			}
		}

		if (!this.right) {
			document.nodes.push(new ExpressionErrorNode(this, "Missing right expression!"));
			return;
		}
	}
}

export class UCAssignmentOperatorExpression extends UCAssignmentExpression {

}

export class UCDefaultAssignmentExpression extends UCBinaryOperatorExpression {
	getTypeKind(): UCTypeKind {
		return UCTypeKind.Error;
	}

	analyze(document: UCDocument, context?: UCStructSymbol) {
		const letSymbol = this.left && this.left.getMemberSymbol();
		if (letSymbol instanceof UCSymbol) {
			if (letSymbol instanceof UCPropertySymbol) {
				// TODO: check right type
			} else if (letSymbol instanceof UCDelegateSymbol) {
				// TODO: check right type
			} else {
				const errorNode = new ExpressionErrorNode(this.left!, `Type of '${letSymbol.getQualifiedName()}' cannot be assigned a default value!`);
				document.nodes.push(errorNode);
			}
		}

		// TODO: pass valid type information
		super.analyze(document, context);
	}
}

export class UCMemberExpression extends UCExpression {
	constructor(protected symbolRef: UCSymbolReference) {
		super(symbolRef.getRange());
	}

	getId(): Name {
		return this.symbolRef.getId();
	}

	getMemberSymbol() {
		return this.symbolRef.getReference();
	}

	getTypeKind(): UCTypeKind {
		return this.symbolRef.getTypeKind();
	}

	getContainedSymbolAtPos(_position: Position) {
		// Only return if we have a RESOLVED reference.
		return this.symbolRef.getReference() && this.symbolRef;
	}

	index(document: UCDocument, context: UCStructSymbol) {
		const id = this.symbolRef.getId();
		const hasArguments = this.outer instanceof UCCallExpression;
		if (hasArguments) {
			// We must match a predefined type over any class or scope symbol!
			// FIXME: What about casting a byte to an ENUM type?
			let type: ISymbol | undefined;
			if (type = TypeCastMap.get(id)) {
				this.symbolRef.setReference(type, document, true);
			} else if (type = ClassesTable.findSymbol(id, true) || ObjectsTable.findSymbol(id)) {
				this.symbolRef.setReference(type, document);
				return;
			}
		}

		// FIXME: only lookup an enumMember if the context value is either an enum, byte, or int.
		const symbol = context.findSuperSymbol(id) || getEnumMember(id);
		if (symbol) {
			const ref = this.symbolRef.setReference(symbol, document);
			if (ref) {
				// Check if we are being assigned a value.
				// FIXME: This is very ugly and should instead be determined by passing down a more verbose context to index().
				ref.inAssignment = (this.outer instanceof UCAssignmentExpression && this.outer.left === this)
				|| this.outer instanceof UCPropertyAccessExpression
				&& this.outer.member === this
				&& this.outer.outer instanceof UCAssignmentExpression
				&& this.outer.outer.left === this.outer;
			}
		}
	}

	analyze(document: UCDocument, context?: UCStructSymbol | ISymbol) {
		if (context && !(context instanceof UCStructSymbol)) {
			document.nodes.push(new SemanticErrorNode(this.symbolRef, `'${context.getQualifiedName()}' is an inaccessible type!`));
		} else if (!this.getMemberSymbol()) {
			document.nodes.push(new UnrecognizedFieldNode(this.symbolRef, context));
		}
	}
}

// Resolves the member for predefined specifiers such as (self, default, static, and global)
export class UCPredefinedAccessExpression extends UCMemberExpression {
	getTypeKind(): UCTypeKind {
		return UCTypeKind.Object;
	}

	index(document: UCDocument, _context?: UCStructSymbol) {
		this.symbolRef.setReference(
			document.class!,
			document, true
		);
	}
}

// Resolves the context for predefined specifiers such as (default, static, and const).
export class UCPredefinedPropertyAccessExpression extends UCMemberExpression {
	getTypeKind(): UCTypeKind {
		return UCTypeKind.Object;
	}

	index(document: UCDocument, context?: UCStructSymbol) {
		if (context) {
			this.symbolRef.setReference(
				context instanceof UCClassSymbol
					? context
					: document.class!,
				document, true
			);
		}
	}
}

export class UCSuperExpression extends UCExpression {
	public structRef?: UCSymbolReference;

	// Resolved structRef.
	private superStruct?: UCStructSymbol;

	getMemberSymbol() {
		return this.superStruct;
	}

	getTypeKind(): UCTypeKind {
		return this.superStruct ? this.superStruct.getTypeKind() : UCTypeKind.Error;
	}

	getContainedSymbolAtPos(position: Position) {
		if (this.structRef && this.structRef.getSymbolAtPos(position)) {
			return this.structRef;
		}
	}

	index(document: UCDocument, context: UCStructSymbol) {
		context = (context instanceof UCMethodSymbol && context.outer instanceof UCStateSymbol && context.outer.super)
			? context.outer
			: document.class!;

		if (this.structRef) {
			// FIXME: UE2 doesn't verify inheritance, thus particular exploits are possible by calling a super function through an unrelated class,
			// -- this let's programmers write data in different parts of the memory.
			// -- Thus should we just be naive and match any type instead?
			const symbol = findSuperStruct(context, this.structRef.getId()) || ClassesTable.findSymbol(this.structRef.getId(), true);
			if (symbol instanceof UCStructSymbol) {
				this.structRef.setReference(symbol, document);
				this.superStruct = symbol;
			}
		} else {
			this.superStruct = context.super;
		}
	}

	// TODO: verify class type by inheritance
	analyze(document: UCDocument, _context?: UCStructSymbol) {
		if (this.structRef) {
			analyzeTypeSymbol(document, this.structRef);
		}
	}
}

export class UCNewExpression extends UCCallExpression {
	// TODO: Implement pseudo new operator for hover info?
	getTypeKind(): UCTypeKind {
		return UCTypeKind.Object;
	}
}

export abstract class UCLiteral extends UCExpression {
	getValue(): number | undefined {
		return undefined;
	}

	getMemberSymbol(): ISymbol | undefined {
		return undefined;
	}

	getContainedSymbolAtPos(_position: Position): ISymbol | undefined {
		return undefined;
	}

	index(_document: UCDocument, _context?: UCStructSymbol): void { }
	analyze(_document: UCDocument, _context?: UCStructSymbol): void { }
}

export class UCNoneLiteral extends UCLiteral {
	getTypeKind(): UCTypeKind {
		return UCTypeKind.None;
	}
}

export class UCStringLiteral extends UCLiteral {
	getTypeKind(): UCTypeKind {
		return UCTypeKind.String;
	}
}

export class UCNameLiteral extends UCLiteral {
	getTypeKind(): UCTypeKind {
		return UCTypeKind.Name;
	}
}

export class UCBoolLiteral extends UCLiteral {
	getTypeKind(): UCTypeKind {
		return UCTypeKind.Bool;
	}
}

export class UCFloatLiteral extends UCLiteral {
	value: number;

	getValue(): number {
		return this.value;
	}

	getTypeKind(): UCTypeKind {
		return UCTypeKind.Float;
	}
}

export class UCIntLiteral extends UCLiteral {
	value: number;

	getValue(): number {
		return this.value;
	}

	getTypeKind(): UCTypeKind {
		return UCTypeKind.Int;
	}
}

export class UCByteLiteral extends UCLiteral {
	value: number;

	getValue(): number {
		return this.value;
	}

	getTypeKind(): UCTypeKind {
		return UCTypeKind.Byte;
	}
}

export class UCObjectLiteral extends UCExpression {
	public castRef: UCSymbolReference;
	public objectRef?: ITypeSymbol;

	getMemberSymbol() {
		return this.objectRef && this.objectRef.getReference() || this.castRef.getReference() || NativeClass;
	}

	getTypeKind(): UCTypeKind {
		// FIXME: Should we return objectRef's getTypeKind()?
		// -- or should we assume that we always have at the very least an OBJECT
		return UCTypeKind.Object;
	}

	getContainedSymbolAtPos(position: Position) {
		if (intersectsWith(this.castRef.getRange(), position)) {
			return this.castRef.getReference() && this.castRef;
		}

		if (this.objectRef && intersectsWith(this.objectRef.getRange(), position)) {
			return this.objectRef.getReference() && this.objectRef;
		}
	}

	index(document: UCDocument, context: UCStructSymbol) {
		const castSymbol = ClassesTable.findSymbol(this.castRef.getId(), true);
		if (castSymbol) {
			this.castRef.setReference(castSymbol, document);
		}

		this.objectRef && this.objectRef.index(document, context);
	}

	// TODO: verify class type by inheritance
	analyze(document: UCDocument, _context?: UCStructSymbol) {
		const castSymbol = this.castRef.getReference();
		const objectSymbol = this.objectRef && this.objectRef.getReference();
		if (this.objectRef) {
			if (!objectSymbol) {
				document.nodes.push(new UnrecognizedFieldNode(this.objectRef));
			}
			else if (castSymbol === NativeClass && !(objectSymbol instanceof UCClassSymbol)) {
				document.nodes.push(new SemanticErrorNode(this.objectRef, `Type of '${objectSymbol.getQualifiedName()}' is not a class!`));
			}
			else if (castSymbol === NativeEnum && !(objectSymbol instanceof UCEnumSymbol)) {
				document.nodes.push(new SemanticErrorNode(this.objectRef, `Type of '${objectSymbol.getQualifiedName()}' is not an enum!`));
			}
		}

		if (!castSymbol) {
			document.nodes.push(new UnrecognizedTypeNode(this.castRef));
		}
	}
}

// Struct literals are limited to Vector, Rotator, and Range.
export abstract class UCStructLiteral extends UCExpression {
	structType: UCSymbolReference;

	getMemberSymbol() {
		return this.structType.getReference();
	}

	getTypeKind(): UCTypeKind {
		return UCTypeKind.Struct;
	}

	getContainedSymbolAtPos(_position: Position) {
		// Only return if we have a RESOLVED reference.
		return this.structType.getReference() && this.structType as ISymbol;
	}

	index(document: UCDocument, _context?: UCStructSymbol) {
		const symbol = ObjectsTable.findSymbol(this.structType.getId());
		if (symbol) {
			this.structType.setReference(symbol, document, undefined, this.getRange());
		}
	}
}

export class UCDefaultStructLiteral extends UCExpression {
	public arguments?: Array<IExpression | undefined>;

	getTypeKind(): UCTypeKind {
		return UCTypeKind.Struct;
	}

	getContainedSymbolAtPos(position: Position) {
		if (this.arguments) for (const arg of this.arguments) {
			const symbol = arg && arg.getSymbolAtPos(position);
			if (symbol) {
				return symbol;
			}
		}
	}

	index(document: UCDocument, context?: UCStructSymbol) {
		if (this.arguments) for (const arg of this.arguments) {
			arg && arg.index(document, context);
		}
	}

	analyze(document: UCDocument, context?: UCStructSymbol) {
		if (this.arguments) for (const arg of this.arguments) {
			arg && arg.analyze(document, context);
		}
	}
}

export class UCVectLiteral extends UCStructLiteral {
	structType = VectorTypeRef;

	getContainedSymbolAtPos(_position: Position) {
		return VectMethodLike as unknown as UCSymbolReference;
	}
}

export class UCRotLiteral extends UCStructLiteral {
	structType = RotatorTypeRef;

	getContainedSymbolAtPos(_position: Position) {
		return RotMethodLike as unknown as UCSymbolReference;
	}
}

export class UCRngLiteral extends UCStructLiteral {
	structType = RangeTypeRef;

	getContainedSymbolAtPos(_position: Position) {
		return RngMethodLike as unknown as UCSymbolReference;
	}
}

// See also @UCArrayCountExpression, this literal is restricted to const value tokens.
export class UCArrayCountLiteral extends UCLiteral {
	public argumentRef?: ITypeSymbol;

	getValue() {
		const symbol = this.argumentRef && this.argumentRef.getReference();
		return symbol instanceof UCPropertySymbol && symbol.getArrayDimSize() || undefined;
	}

	getTypeKind(): UCTypeKind {
		return UCTypeKind.Int;
	}

	getContainedSymbolAtPos(position: Position) {
		return this.argumentRef && this.argumentRef.getSymbolAtPos(position) && this.argumentRef;
	}

	index(document: UCDocument, context?: UCStructSymbol) {
		super.index(document, context);
		this.argumentRef && this.argumentRef.index(document, context!);
	}

	// TODO: Validate that referred property is a valid static array!
	analyze(document: UCDocument, context?: UCStructSymbol) {
		super.analyze(document, context);

		if (this.argumentRef) {
			analyzeTypeSymbol(document, this.argumentRef);
		}
	}
}

export class UCNameOfLiteral extends UCLiteral {
	public argumentRef?: ITypeSymbol;

	getTypeKind(): UCTypeKind {
		return UCTypeKind.Name;
	}

	getContainedSymbolAtPos(position: Position) {
		return this.argumentRef && this.argumentRef.getSymbolAtPos(position) && this.argumentRef;
	}

	index(document: UCDocument, context?: UCStructSymbol) {
		super.index(document, context);
		this.argumentRef && this.argumentRef.index(document, context!);
	}

	analyze(document: UCDocument, context?: UCStructSymbol) {
		super.analyze(document, context);
		if (this.argumentRef) {
			analyzeTypeSymbol(document, this.argumentRef);
		}
	}
}

export class UCSizeOfLiteral extends UCLiteral {
	public argumentRef?: ITypeSymbol;

	getValue() {
		// FIXME: We don't have the data to calculate a class's size.
		// const symbol = this.argumentRef && this.argumentRef.getReference();
		return undefined;
	}

	getTypeKind(): UCTypeKind {
		return UCTypeKind.Int;
	}

	getContainedSymbolAtPos(position: Position) {
		return this.argumentRef && this.argumentRef.getSymbolAtPos(position) && this.argumentRef;
	}

	index(document: UCDocument, context?: UCStructSymbol) {
		super.index(document, context);
		this.argumentRef && this.argumentRef.index(document, context!);
	}

	analyze(document: UCDocument, context?: UCStructSymbol) {
		super.analyze(document, context);
		if (this.argumentRef) {
			analyzeTypeSymbol(document, this.argumentRef);
		}
	}
}

export class UCMetaClassExpression extends UCParenthesizedExpression {
	public classRef?: UCObjectTypeSymbol;

	getMemberSymbol() {
		return this.classRef && this.classRef.getReference() || NativeClass;
	}

	getTypeKind(): UCTypeKind {
		return UCTypeKind.Class;
	}

	getContainedSymbolAtPos(position: Position) {
		const subSymbol = this.classRef && this.classRef.getSymbolAtPos(position) as UCObjectTypeSymbol;
		return subSymbol && subSymbol.getReference() && this.classRef || super.getContainedSymbolAtPos(position);
	}

	index(document: UCDocument, context?: UCStructSymbol) {
		super.index(document, context);
		this.classRef && this.classRef.index(document, context!);
	}

	// TODO: verify class type by inheritance
	analyze(document: UCDocument, context?: UCStructSymbol) {
		super.analyze(document, context);
		if (this.classRef) {
			analyzeTypeSymbol(document, this.classRef);
		}
	}
}