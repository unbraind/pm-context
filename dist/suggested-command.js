/** Shell-independent command suggestions with one auditable POSIX display renderer. */
import { PmCliError } from "@unbrained/pm-cli/sdk";
/** Preserve a single argument exactly, including empty strings and embedded single quotes. */
export function quotePosixArgument(value) {
    if (value.includes("\0"))
        throw new PmCliError("Command arguments cannot contain NUL bytes.", 2, { code: "INVALID_COMMAND_ARGUMENT", nextSteps: ["Remove NUL bytes; operating systems cannot represent them in argv."] });
    return /^[A-Za-z0-9_./:=,+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
/** Copy and validate a dense bounded argv before rendering; never parse or execute shell text. */
export function buildSuggestedCommand(argv) {
    if (!Array.isArray(argv) || argv.length < 1 || argv.length > 4096 || Object.keys(argv).length !== argv.length || !Array.from({ length: argv.length }, (_, i) => Object.hasOwn(argv, i) && typeof argv[i] === "string").every(Boolean) || Buffer.byteLength(JSON.stringify(argv)) > 262144)
        throw new PmCliError("Supply a dense argv of 1-4096 strings, at most 262144 JSON bytes.", 2, { code: "INVALID_COMMAND_ARGUMENT", nextSteps: ["Supply argument strings instead of shell text; narrow oversized commands."] });
    const copied = [...argv];
    return { argv: copied, command: copied.map(quotePosixArgument).join(" ") };
}
/** Generate both restoration fields from the same original argv. */
export function buildRestoreCommand(argv) {
    const value = buildSuggestedCommand(argv);
    return { restore_with: value.command, restore_argv: value.argv };
}
//# sourceMappingURL=suggested-command.js.map