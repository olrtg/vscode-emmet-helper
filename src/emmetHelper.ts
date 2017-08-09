/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { TextDocument, Position, Range, CompletionItem, CompletionList, TextEdit, InsertTextFormat } from 'vscode-languageserver-types'
import { expand, createSnippetsRegistry } from './expand/expand-full';
import * as extract from '@emmetio/extract-abbreviation';
import * as path from 'path';
import * as fs from 'fs';

const snippetKeyCache = new Map<string, string[]>();
let markupSnippetKeys: string[];
let markupSnippetKeysRegex: RegExp[];
const htmlAbbreviationStartRegex = /^[a-z,A-Z,!,(,[,#,\.]/;
const htmlAbbreviationEndRegex = /[a-z,A-Z,!,),\],#,\.,},\d,*,$]$/;
const cssAbbreviationRegex = /^[a-z,A-Z,!,@,#]/;
const emmetModes = ['html', 'pug', 'slim', 'haml', 'xml', 'xsl', 'jsx', 'css', 'scss', 'sass', 'less', 'stylus'];
const commonlyUsedTags = ['div', 'span', 'p', 'b', 'i', 'body', 'html', 'ul', 'ol', 'li', 'head', 'script', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section'];
const bemFilterSuffix = 'bem';
const filterDelimitor = '|';
const trimFilterSuffix = 't';

export interface EmmetConfiguration {
	useNewEmmet: boolean;
	showExpandedAbbreviation: string;
	showAbbreviationSuggestions: boolean;
	syntaxProfiles: object;
	variables: object;
}

export function doComplete(document: TextDocument, position: Position, syntax: string, emmetConfig: EmmetConfiguration): CompletionList {

	if (!emmetConfig.useNewEmmet || emmetConfig.showExpandedAbbreviation === 'never' || emmetModes.indexOf(syntax) === -1) {
		return;
	}

	if (!isStyleSheet(syntax)) {
		if (!snippetKeyCache.has(syntax) || !markupSnippetKeysRegex || markupSnippetKeysRegex.length === 0) {
			let registry = customSnippetRegistry[syntax] ? customSnippetRegistry[syntax] : createSnippetsRegistry(syntax);

			if (!snippetKeyCache.has(syntax)) {
				snippetKeyCache.set(syntax, registry.all({ type: 'string' }).map(snippet => {
					return snippet.key;
				}));
			}

			markupSnippetKeysRegex = registry.all({ type: 'regexp' }).map(snippet => {
				return snippet.key;
			});

		}
		markupSnippetKeys = snippetKeyCache.get(syntax);
	}

	let expandedAbbr: CompletionItem;
	let { abbreviationRange, abbreviation, filters } = extractAbbreviation(document, position);
	let expandOptions = getExpandOptions(syntax, emmetConfig.syntaxProfiles, emmetConfig.variables, filters);

	if (isAbbreviationValid(syntax, abbreviation)) {
		let expandedText;
		// Skip non stylesheet abbreviations that are just letters/numbers unless they are valid snippets or commonly used tags
		// This is to avoid noise where abc -> <abc>${1}</abc> 
		// Also skip abbreviations ending with `.` This will be noise when people are typing simple text and ending it with period.
		if (isStyleSheet(syntax)
			|| (!/^[a-z,A-Z,\d]*$/.test(abbreviation) && !abbreviation.endsWith('.'))
			|| markupSnippetKeys.indexOf(abbreviation) > -1
			|| commonlyUsedTags.indexOf(abbreviation) > -1
			|| markupSnippetKeysRegex.find(x => x.test(abbreviation))) {
			try {
				expandedText = expand(abbreviation, expandOptions);
				// Skip cases when abc -> abc: ; as this is noise
				if (isStyleSheet(syntax) && expandedText === `${abbreviation}: \${1};`) {
					expandedText = '';
				}
			} catch (e) {

			}
		}

		if (expandedText) {
			expandedAbbr = CompletionItem.create(abbreviation);
			expandedAbbr.textEdit = TextEdit.replace(abbreviationRange, expandedText);
			expandedAbbr.documentation = replaceTabStopsWithCursors(expandedText);
			expandedAbbr.insertTextFormat = InsertTextFormat.Snippet;
			expandedAbbr.detail = 'Emmet Abbreviation';
			if (filters.indexOf('bem') > -1) {
				expandedAbbr.label = abbreviation + filterDelimitor + bemFilterSuffix;
			}
			if (isStyleSheet(syntax)) {
				let expandedTextWithoutTabStops = removeTabStops(expandedText);

				// See https://github.com/Microsoft/vscode/issues/28933#issuecomment-309236902
				// Due to this we set filterText, sortText and label to expanded abbreviation
				// - Label makes it clear to the user what their choice is
				// - FilterText fixes the issue when user types in propertyname and emmet uses it to match with abbreviations
				// - SortText will sort the choice in a way that is intutive to the user
				expandedAbbr.filterText = expandedTextWithoutTabStops;
				expandedAbbr.sortText = expandedTextWithoutTabStops;
				expandedAbbr.label = expandedTextWithoutTabStops;
				return CompletionList.create([expandedAbbr], true);
			}
		}
	}

	let completionItems: CompletionItem[] = expandedAbbr ? [expandedAbbr] : [];
	if (!isStyleSheet(syntax)) {
		if (expandedAbbr) {
			// Workaround for the main expanded abbr not appearing before the snippet suggestions
			expandedAbbr.sortText = '0' + expandedAbbr.label;
		}

		let currentWord = getCurrentWord(document, position);
		let commonlyUsedTagSuggestions = makeSnippetSuggestion(commonlyUsedTags, currentWord, abbreviation, abbreviationRange, expandOptions);
		completionItems = completionItems.concat(commonlyUsedTagSuggestions);

		if (emmetConfig.showAbbreviationSuggestions) {
			let abbreviationSuggestions = getAbbreviationSuggestions(syntax, currentWord, abbreviation, abbreviationRange, expandOptions);
			completionItems = completionItems.concat(abbreviationSuggestions);
		}

	}
	return CompletionList.create(completionItems, true);
}

function makeSnippetSuggestion(snippets: string[], prefix: string, abbreviation: string, abbreviationRange: Range, expandOptions: any): CompletionItem[] {
	if (!prefix) {
		return [];
	}
	let snippetCompletions = [];
	snippets.forEach(snippetKey => {
		if (!snippetKey.startsWith(prefix) || snippetKey === prefix) {
			return;
		}

		let currentAbbr = abbreviation + snippetKey.substr(prefix.length);
		let expandedAbbr;
		try {
			expandedAbbr = expand(currentAbbr, expandOptions);
		} catch (e) {

		}

		let item = CompletionItem.create(snippetKey);
		item.documentation = replaceTabStopsWithCursors(expandedAbbr);
		item.detail = 'Emmet Abbreviation';
		item.textEdit = TextEdit.replace(abbreviationRange, expandedAbbr);
		item.insertTextFormat = InsertTextFormat.Snippet;

		// Workaround for snippet suggestions items getting filtered out as the complete abbr does not start with snippetKey 
		item.filterText = abbreviation;

		// Workaround for the main expanded abbr not appearing before the snippet suggestions
		item.sortText = '9' + abbreviation;

		snippetCompletions.push(item);
	});
	return snippetCompletions;
}

function getAbbreviationSuggestions(syntax: string, prefix: string, abbreviation: string, abbreviationRange: Range, expandOptions: object): CompletionItem[] {
	if (!prefix || isStyleSheet(syntax)) {
		return [];
	}

	let snippetKeys = snippetKeyCache.has(syntax) ? snippetKeyCache.get(syntax) : snippetKeyCache.get('html');
	let snippetCompletions = [];

	return makeSnippetSuggestion(snippetKeys, prefix, abbreviation, abbreviationRange, expandOptions);;
}

function getCurrentWord(document: TextDocument, position: Position): string {
	let currentLine = getCurrentLine(document, position);
	if (currentLine) {
		let matches = currentLine.match(/[\w,:]*$/);
		if (matches) {
			return matches[0];
		}
	}
}

function replaceTabStopsWithCursors(expandedWord: string): string {
	return expandedWord.replace(/\$\{\d+\}/g, '|').replace(/\$\{\d+:([^\}]+)\}/g, '$1');
}

function removeTabStops(expandedWord: string): string {
	return expandedWord.replace(/\$\{\d+\}/g, '').replace(/\$\{\d+:([^\}]+)\}/g, '$1');
}

function getCurrentLine(document: TextDocument, position: Position): string {
	let offset = document.offsetAt(position);
	let text = document.getText();
	let start = 0;
	let end = text.length;
	for (let i = offset - 1; i >= 0; i--) {
		if (text[i] === '\n') {
			start = i + 1;
			break;
		}
	}
	for (let i = offset; i < text.length; i++) {
		if (text[i] === '\n') {
			end = i;
			break;
		}
	}
	return text.substring(start, end);
}

let customSnippetRegistry = {};
let variablesFromFile = {};
let profilesFromFile = {};

export const emmetSnippetField = (index, placeholder) => `\${${index}${placeholder ? ':' + placeholder : ''}}`;

export function isStyleSheet(syntax): boolean {
	let stylesheetSyntaxes = ['css', 'scss', 'sass', 'less', 'stylus'];
	return (stylesheetSyntaxes.indexOf(syntax) > -1);
}

/**
 * Extracts abbreviation from the given position in the given document
 */
export function extractAbbreviation(document: TextDocument, position: Position) {
	let filters = [];
	let pos = position.character;
	let currentLine = getCurrentLine(document, position);
	let currentLineTillPosition = currentLine.substr(0, position.character);
	let lengthOccupiedByFilter = 0;
	if (currentLineTillPosition.endsWith(`${filterDelimitor}${bemFilterSuffix}`)) {
		lengthOccupiedByFilter = 4;
		pos -= lengthOccupiedByFilter;
		filters.push(bemFilterSuffix)
	}
	let result;
	try {
		result = extract(currentLine, pos, true);
	}
	catch (e) {
	}
	if (!result) {
		return null;
	}
	let rangeToReplace = Range.create(position.line, result.location, position.line, result.location + result.abbreviation.length + lengthOccupiedByFilter);
	return {
		abbreviationRange: rangeToReplace,
		abbreviation: result.abbreviation,
		filters
	};
}

export function extractAbbreviationFromText(text: string): any {
	let filters = [];
	if (!text) {
		return {
			abbreviation: '',
			filters
		}
	}
	let pos = text.length;
	if (text.endsWith(`${filterDelimitor}${bemFilterSuffix}`)) {
		pos -= bemFilterSuffix.length + 1;
		filters.push(bemFilterSuffix)
	} else if (text.endsWith(`${filterDelimitor}${trimFilterSuffix}`)) {
		pos -= trimFilterSuffix.length + 1;
		filters.push(trimFilterSuffix)
	}
	let result;
	try {
		result = extract(text, pos, true);
	}
	catch (e) {
	}
	if (!result) {
		return null;
	}
	return {
		abbreviation: result.abbreviation,
		filters
	};
}

/**
 * Returns a boolean denoting validity of given abbreviation in the context of given syntax
 * Not needed once https://github.com/emmetio/atom-plugin/issues/22 is fixed
 * @param syntax string
 * @param abbreviation string
 */
export function isAbbreviationValid(syntax: string, abbreviation: string): boolean {
	if (isStyleSheet(syntax)) {
		return cssAbbreviationRegex.test(abbreviation);
	}
	if (abbreviation.startsWith('!') && /[^!]/.test(abbreviation)) {
		return false;
	}
	// Its common for users to type (sometextinsidebrackets), this should not be treated as an abbreviation
	if (abbreviation.startsWith('(') && abbreviation.endsWith(')') && !/^\(.+[>,+,*].+\)$/.test(abbreviation)) {
		return false;
	}
	return (htmlAbbreviationStartRegex.test(abbreviation) && htmlAbbreviationEndRegex.test(abbreviation));
}

/**
 * Returns options to be used by the expand module
 * @param syntax 
 * @param textToReplace 
 */
export function getExpandOptions(syntax: string, syntaxProfiles?: object, variables?: object, filters?: string[], ) {
	let baseSyntax = isStyleSheet(syntax) ? 'css' : 'html';
	if (!customSnippetRegistry[syntax] && customSnippetRegistry[baseSyntax]) {
		customSnippetRegistry[syntax] = customSnippetRegistry[baseSyntax];
	}
	let addons = {};
	if (filters && filters.indexOf('bem') > -1) {
		addons['bem'] = { element: '__' };
	}
	if (syntax === 'jsx') {
		addons['jsx'] = true;
	}
	return {
		field: emmetSnippetField,
		syntax: syntax,
		profile: getProfile(syntax, syntaxProfiles),
		addons: addons,
		variables: getVariables(variables),
		snippets: customSnippetRegistry[syntax]
	};
}

/**
 * Expands given abbreviation using given options
 * @param abbreviation string
 * @param options 
 */
export function expandAbbreviation(abbreviation: string, options: any) {
	return expand(abbreviation, options);
}

/**
 * Maps and returns syntaxProfiles of previous format to ones compatible with new emmet modules
 * @param syntax 
 */
function getProfile(syntax: string, profilesFromSettings: object): any {
	if (!profilesFromSettings) {
		profilesFromSettings = {};
	}
	let profilesConfig = Object.assign({}, profilesFromFile, profilesFromSettings);

	let options = profilesConfig[syntax];
	if (!options || typeof options === 'string') {
		if (options === 'xhtml') {
			return {
				selfClosingStyle: 'xhtml'
			};
		}
		return {};
	}
	let newOptions = {};
	for (let key in options) {
		switch (key) {
			case 'tag_case':
				newOptions['tagCase'] = (options[key] === 'lower' || options[key] === 'upper') ? options[key] : '';
				break;
			case 'attr_case':
				newOptions['attributeCase'] = (options[key] === 'lower' || options[key] === 'upper') ? options[key] : '';
				break;
			case 'attr_quotes':
				newOptions['attributeQuotes'] = options[key];
				break;
			case 'tag_nl':
				newOptions['format'] = (options[key] === true || options[key] === false) ? options[key] : true;
				break;
			case 'inline_break':
				newOptions['inlineBreak'] = options[key];
				break;
			case 'self_closing_tag':
				if (options[key] === true) {
					newOptions['selfClosingStyle'] = 'xml'; break;
				}
				if (options[key] === false) {
					newOptions['selfClosingStyle'] = 'html'; break;
				}
				newOptions['selfClosingStyle'] = options[key];
				break;
			default:
				newOptions[key] = options[key];
				break;
		}
	}
	return newOptions;
}

/**
 * Returns variables to be used while expanding snippets
 */
function getVariables(variablesFromSettings: object): any {
	if (!variablesFromSettings) {
		return variablesFromFile;
	}
	return Object.assign({}, variablesFromFile, variablesFromSettings);
}

/**
 * Updates customizations from snippets.json and syntaxProfiles.json files in the directory configured in emmet.extensionsPath setting
 */
export function updateExtensionsPath(emmetExtensionsPath: string): Promise<void> {
	if (!emmetExtensionsPath || !emmetExtensionsPath.trim() || !path.isAbsolute(emmetExtensionsPath.trim()) || !dirExists(emmetExtensionsPath.trim())) {
		customSnippetRegistry = {};
		snippetKeyCache.clear();
		profilesFromFile = {};
		variablesFromFile = {};
		return Promise.resolve();
	}

	let dirPath = emmetExtensionsPath.trim();
	let snippetsPath = path.join(dirPath, 'snippets.json');
	let profilesPath = path.join(dirPath, 'syntaxProfiles.json');

	let snippetsPromise = new Promise<void>((resolve, reject) => {
		fs.readFile(snippetsPath, (err, snippetsData) => {
			if (err) {
				return resolve();
			}
			try {
				let snippetsJson = JSON.parse(snippetsData.toString());
				variablesFromFile = snippetsJson['variables'];
				customSnippetRegistry = {};
				snippetKeyCache.clear();
				Object.keys(snippetsJson).forEach(syntax => {
					if (!snippetsJson[syntax]['snippets']) {
						return;
					}
					let baseSyntax = isStyleSheet(syntax) ? 'css' : 'html';
					let customSnippets = snippetsJson[syntax]['snippets'];
					if (snippetsJson[baseSyntax]['snippets'] && baseSyntax !== syntax) {
						customSnippets = Object.assign({}, snippetsJson[baseSyntax]['snippets'], snippetsJson[syntax]['snippets'])
					}

					customSnippetRegistry[syntax] = createSnippetsRegistry(syntax, customSnippets);

					let snippetKeys: string[] = customSnippetRegistry[syntax].all({ type: 'string' }).map(snippet => {
						return snippet.key;
					});
					snippetKeyCache.set(syntax, snippetKeys);
				});
			} catch (e) {

			}
			return resolve();
		});
	});

	let variablesPromise = new Promise<void>((resolve, reject) => {
		fs.readFile(profilesPath, (err, profilesData) => {
			try {
				if (!err) {
					profilesFromFile = JSON.parse(profilesData.toString());
				}
			} catch (e) {

			}
			return resolve();
		});
	});

	return Promise.all([snippetsPromise, variablesFromFile]).then(() => Promise.resolve());

}

function dirExists(dirPath: string): boolean {
	try {

		return fs.statSync(dirPath).isDirectory();
	} catch (e) {
		return false;
	}
}

/**
* Get the corresponding emmet mode for given vscode language mode
* Eg: jsx for typescriptreact/javascriptreact or pug for jade
* If the language is not supported by emmet or has been exlcuded via `exlcudeLanguages` setting, 
* then nothing is returned
* 
* @param language 
* @param exlcudedLanguages Array of language ids that user has chosen to exlcude for emmet
*/
export function getEmmetMode(language: string, excludedLanguages: string[]): string {
	if (!language || excludedLanguages.indexOf(language) > -1) {
		return;
	}
	if (/\b(typescriptreact|javascriptreact|jsx-tags)\b/.test(language)) { // treat tsx like jsx
		return 'jsx';
	}
	if (language === 'sass-indented') { // map sass-indented to sass
		return 'sass';
	}
	if (language === 'jade') {
		return 'pug';
	}
	if (emmetModes.indexOf(language) > -1) {
		return language;
	}
}






