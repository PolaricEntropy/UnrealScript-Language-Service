import { DefaultErrorStrategy, Parser, RecognitionException, ParserRuleContext } from 'antlr4ts';

import { UCParser } from '../../antlr/UCParser';

export class UCMissingSemicolonException extends Error {
	constructor(private context: ParserRuleContext) {
		super();
	}
}

export class UCErrorStrategy extends DefaultErrorStrategy {
	reportError(recognizer: Parser, e: RecognitionException) {
		if (e.expectedTokens && e.expectedTokens.contains(UCParser.SEMICOLON)) {
			const token = this.constructToken(
				recognizer.inputStream.tokenSource,
				UCParser.SEMICOLON, ';',
				recognizer.currentToken
			);

			const errorNode = recognizer.createErrorNode(recognizer.context, token);
			recognizer.context.addErrorNode(errorNode);
		}

		super.reportError(recognizer, e);
	}
}

export const ERROR_STRATEGY = new UCErrorStrategy();
