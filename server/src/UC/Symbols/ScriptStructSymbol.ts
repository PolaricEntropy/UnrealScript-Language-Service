import { SymbolKind, CompletionItemKind } from 'vscode-languageserver-types';

import { UCDocument } from '../document';
import { SymbolWalker } from '../symbolWalker';

import {
	UCTypeKind, ISymbol,
	UCStructSymbol, UCSymbol,
	UCMethodSymbol, UCPropertySymbol
} from '.';

export class UCScriptStructSymbol extends UCStructSymbol {
	isProtected(): boolean {
		return true;
	}

	isType(): boolean {
		return true;
	}

	getKind(): SymbolKind {
		return SymbolKind.Struct;
	}

	getTypeKind() {
		return UCTypeKind.Struct;
	}

	getCompletionItemKind(): CompletionItemKind {
		return CompletionItemKind.Struct;
	}

	getTooltip(): string {
		return `struct ${this.getQualifiedName()}`;
	}

	getCompletionSymbols(_document: UCDocument): ISymbol[] {
		const symbols: ISymbol[] = [];
		for (let child = this.children; child; child = child.next) {
			symbols.push(child);
		}

		for (let parent = this.super; parent; parent = parent.super) {
			for (let child = parent.children; child; child = child.next) {
				symbols.push(child);
			}
		}
		return symbols;
	}

	acceptCompletion(_document: UCDocument, context: UCSymbol): boolean {
		return (context instanceof UCPropertySymbol || context instanceof UCMethodSymbol);
	}

	index(document: UCDocument, context: UCStructSymbol) {
		super.index(document, this);
	}

	accept<Result>(visitor: SymbolWalker<Result>): Result {
		return visitor.visitScriptStruct(this);
	}
}
