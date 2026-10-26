/** Execute argv directly; command is only the equivalent POSIX display form. */
export interface SuggestedCommand {
    argv: string[];
    command: string;
}
/** SDK-compatible omission field with an executable argument array alongside its display. */
export interface SuggestedRestore {
    restore_with: string;
    restore_argv: string[];
}
/** Preserve a single argument exactly, including empty strings and embedded single quotes. */
export declare function quotePosixArgument(value: string): string;
/** Copy and validate a dense bounded argv before rendering; never parse or execute shell text. */
export declare function buildSuggestedCommand(argv: readonly string[]): SuggestedCommand;
/** Generate both restoration fields from the same original argv. */
export declare function buildRestoreCommand(argv: readonly string[]): SuggestedRestore;
//# sourceMappingURL=suggested-command.d.ts.map