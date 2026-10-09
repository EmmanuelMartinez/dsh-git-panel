import { basename, join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { assertNever } from "@deepseek-ai/dsh-util-values";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { homedir } from "node:os";
import { SubprocessExecutableNotFoundError } from "@deepseek-ai/dsh-subprocess";
//#region ../../packages/git/git-command/src/porcelain.ts
/**
* Parse NUL-terminated numstat records. A rename record carries an empty path
* followed by the old and new paths.
* @param output - complete stdout of `git diff-tree -r -M -z --numstat`.
* @returns records in git's output order.
* @throws when a record is malformed, which indicates truncated output.
*/
function parseNumstat(output) {
	const queue = output.split("\0");
	if (queue.at(-1) !== "") throw new Error("numstat output is not NUL-terminated");
	queue.pop();
	const entries = [];
	while (queue.length > 0) {
		const record = queue.shift();
		const first = record.indexOf("	");
		const second = first < 0 ? -1 : record.indexOf("	", first + 1);
		if (second < 0) throw new Error(`malformed numstat record: ${record}`);
		const added = record.slice(0, first);
		const deleted = record.slice(first + 1, second);
		let target = record.slice(second + 1);
		let oldPath;
		if (target === "") {
			oldPath = queue.shift();
			const renamed = queue.shift();
			if (oldPath === void 0 || renamed === void 0) throw new Error("malformed numstat rename record");
			target = renamed;
		}
		const binary = added === "-";
		entries.push({
			path: target,
			...oldPath === void 0 ? {} : { oldPath },
			added: binary ? 0 : Number(added),
			deleted: binary ? 0 : Number(deleted),
			binary
		});
	}
	return entries;
}
//#endregion
//#region ../../packages/git/git-command/src/index.ts
/**
* One git command through the subprocess seam.
*
* Two capabilities run git here — the turn change recorder and the browser's
* repository panel — and both must run it the same way: never shell-interpreted,
* never waiting on a credential prompt, never reading the user's ambient git
* configuration, never taking an optional lock under the user, and always under
* a caller-owned deadline with bounded output. This package is that one home.
* It also parses the one porcelain form both callers read back: NUL-terminated
* `--numstat` records.
*
* A nonzero exit is data the caller classifies, so nothing here raises one; a
* command that times out, is aborted, or cannot spawn is an exception, and the
* caller owns the cause because the process outcome carries none.
*
* @module @deepseek-ai/dsh-git-command
*/
/** Milliseconds a terminated git range has to exit before it is killed. */
const TERMINATE_GRACE_MS = 2e3;
/** Bytes of one command's stderr kept as its diagnostic tail. */
const STDERR_TAIL_BYTES = 16 * 1024;
/**
* Git's non-interactive environment, layered under every command's own entries.
*
* `GIT_CONFIG_COUNT=0` makes ambient indexed configuration inert: the subprocess
* credential scrub already removes `GIT_CONFIG_KEY_n` (its name matches `KEY`),
* and this makes any survivor meaningless. `GIT_TERMINAL_PROMPT=0` keeps a child
* from waiting on a prompt nobody can answer. `GIT_OPTIONAL_LOCKS=0` stops git
* refreshing an index under the user. `LC_ALL=C` is the stable wording that
* callers classify "not a repository" by.
*/
const GIT_ENV = {
	GIT_CONFIG_COUNT: "0",
	GIT_TERMINAL_PROMPT: "0",
	GIT_OPTIONAL_LOCKS: "0",
	LC_ALL: "C"
};
/** Runs one resolved git executable with a deadline and bounded output. */
var GitRunner = class {
	subprocess;
	executable;
	limits;
	/**
	* @param subprocess - the process seam every command spawns through.
	* @param executable - resolved absolute git executable.
	* @param limits - deadline and output cap for one command.
	*/
	constructor(subprocess, executable, limits) {
		this.subprocess = subprocess;
		this.executable = executable;
		this.limits = limits;
	}
	/**
	* Run one git subcommand to settlement.
	* @param args - arguments after the executable; never shell-interpreted.
	* @param options - directory, cancellation, and per-command overrides.
	* @returns the exit facts and the retained stdout and stderr.
	* @throws Error when the deadline or the caller's signal ended the command, or when the spawn itself failed.
	*/
	async run(args, options) {
		const timeout = AbortSignal.timeout(this.limits.timeoutMs);
		const signal = AbortSignal.any([options.signal, timeout]);
		const handle = this.subprocess.spawn({
			argv: [this.executable, ...args],
			cwd: options.cwd,
			stdio: {
				stdin: options.stdin === void 0 ? "ignore" : { data: options.stdin },
				stdout: { maxBytes: options.maxBytes ?? this.limits.outputMaxBytes },
				stderr: { maxBytes: STDERR_TAIL_BYTES }
			},
			graceMs: TERMINATE_GRACE_MS,
			signal,
			env: {
				...GIT_ENV,
				...options.env
			}
		});
		const outcome = await handle.done;
		if (signal.aborted) {
			const cause = timeout.aborted ? `timed out after ${this.limits.timeoutMs}ms` : "was aborted";
			throw new Error(`git ${args.join(" ")} ${cause}`);
		}
		/* v8 ignore start -- collect-mode stdio always yields both readers. */
		const stdout = handle.collected.stdout?.readFrom(0) ?? {
			text: "",
			lossy: false
		};
		const stderr = handle.collected.stderr?.readFrom(0).text ?? "";
		/* v8 ignore stop */
		return {
			exitCode: outcome.exitCode,
			stdout: stdout.text,
			stderr,
			truncated: stdout.lossy
		};
	}
};
/**
* Resolve the git executable this host can run.
*
* On macOS the `/usr/bin/git` developer-tools stub opens an installer dialog
* instead of running, so it counts as absent until the tools are selected.
* @param subprocess - the process seam used to resolve and probe.
* @param signal - the caller's lifetime; cancels the lookup and the probe.
* @returns the executable path, or the reason none is usable.
* @throws Error when the lookup fails for a reason other than a missing executable.
*/
async function resolveGitExecutable(subprocess, signal) {
	const executable = await subprocess.resolveExecutable("git", void 0, signal).catch((error) => {
		if (error instanceof SubprocessExecutableNotFoundError) return void 0;
		throw error;
	});
	if (executable === void 0) return { reason: "missing" };
	if (process.platform !== "darwin" || executable !== "/usr/bin/git") return { executable };
	return (await subprocess.spawn({
		argv: ["/usr/bin/xcode-select", "-p"],
		cwd: homedir(),
		stdio: {
			stdin: "ignore",
			stdout: { maxBytes: 4096 },
			stderr: { maxBytes: 4096 }
		},
		graceMs: 1e3,
		signal
	}).done.catch(() => ({ exitCode: null }))).exitCode === 0 ? { executable } : { reason: "developer-tools" };
}
//#endregion
//#region ../../packages/api/git-controller/lib/index.js
/**
* Parsers for the git output this service reads.
*
* Every parser is pure and takes the exact bytes one command produced, so the
* controller owns process handling and the shapes stay testable without git.
* Records are NUL-separated wherever a path or a message can contain a newline,
* which is what makes a path list unambiguous; the field separator inside a
* record is the ASCII unit separator, and the free-text field is always last so
* a separator inside it cannot shift another field.
*
* @module @deepseek-ai/dsh-api-git-controller/src/porcelain
*/
/** Field separator inside one record of a custom `--format`. */
const FIELD = "";
/** Record separator: git's own NUL mode for the porcelain commands. */
const RECORD = "\0";
/** Map one porcelain status letter onto a side's kind. */
function statusKind(letter) {
	switch (letter) {
		case ".": return "unmodified";
		case "M": return "modified";
		case "A": return "added";
		case "D": return "deleted";
		case "R": return "renamed";
		case "C": return "copied";
		case "T": return "typechange";
		case "U": return "unmerged";
		default: return "unmodified";
	}
}
/**
* Split one `status` record into its fixed fields and its trailing path, which
* may itself contain spaces and therefore is everything after the last fixed
* field.
* @param record - one NUL-delimited record without its terminator.
* @param pathIndex - how many space-separated fields precede the path.
* @returns the leading fields and the path, or undefined for a short record.
*/
function splitPathRecord(record, pathIndex) {
	const fields = [];
	let position = 0;
	for (let index = 0; index < pathIndex; index += 1) {
		const space = record.indexOf(" ", position);
		if (space === -1) return void 0;
		fields.push(record.slice(position, space));
		position = space + 1;
	}
	return {
		fields,
		path: record.slice(position)
	};
}
/** One `# branch.<key> <value>` header of `status --porcelain=v2 --branch`. */
const BRANCH_HEADER = /^# branch\.([a-z]+)(?: (.*))?$/u;
/**
* Read the branch headers of `status --porcelain=v2 --branch -z`.
* @param output - the command's complete stdout.
* @returns HEAD's fact and the checked-out branch's divergence, when any.
*/
function parseBranchFacts(output) {
	let oid;
	let branch;
	let upstreamRef;
	let ahead = 0;
	let behind = 0;
	for (const record of output.split(RECORD)) {
		const parsed = BRANCH_HEADER.exec(record);
		if (parsed === null) continue;
		const key = parsed[1];
		const value = parsed[2] ?? "";
		if (key === "oid") oid = value === "(initial)" ? void 0 : value;
		else if (key === "head") branch = value === "(detached)" ? void 0 : value;
		else if (key === "upstream") upstreamRef = value;
		else if (key === "ab") {
			const [added, removed] = value.split(" ");
			ahead = Number.parseInt(added?.slice(1) ?? "0", 10);
			behind = Number.parseInt(removed?.slice(1) ?? "0", 10);
		}
	}
	const head = oid === void 0 ? {
		kind: "unborn",
		branch: branch ?? "HEAD"
	} : branch === void 0 ? {
		kind: "detached",
		oid
	} : {
		kind: "branch",
		branch,
		oid
	};
	if (upstreamRef === void 0) return { head };
	return {
		head,
		upstream: {
			ref: upstreamRef,
			ahead: Number.isSafeInteger(ahead) ? ahead : 0,
			behind: Number.isSafeInteger(behind) ? behind : 0
		}
	};
}
/**
* Read the changed-path records of `status --porcelain=v2 -z`.
* @param output - the command's complete stdout; branch headers are ignored.
* @returns one entry per changed path, in git's order.
*/
function parseStatusEntries(output) {
	const records = output.split(RECORD);
	const entries = [];
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		if (record === void 0 || record === "" || record.startsWith("#")) continue;
		const kind = record[0];
		if (kind === "?") {
			const path = record.slice(2);
			if (path !== "") entries.push({
				path,
				index: "unmodified",
				worktree: "untracked"
			});
			continue;
		}
		if (kind === "1") {
			const split = splitPathRecord(record, 8);
			if (split === void 0) continue;
			entries.push({
				path: split.path,
				index: statusKind(split.fields[1]?.[0] ?? "."),
				worktree: statusKind(split.fields[1]?.[1] ?? ".")
			});
			continue;
		}
		if (kind === "2") {
			const split = splitPathRecord(record, 9);
			if (split === void 0) continue;
			const from = records[index + 1];
			index += 1;
			entries.push({
				path: split.path,
				...from === void 0 || from === "" ? {} : { from },
				index: statusKind(split.fields[1]?.[0] ?? "."),
				worktree: statusKind(split.fields[1]?.[1] ?? ".")
			});
			continue;
		}
		if (kind === "u") {
			const split = splitPathRecord(record, 10);
			if (split === void 0) continue;
			entries.push({
				path: split.path,
				index: "unmerged",
				worktree: "unmerged"
			});
		}
	}
	return entries;
}
/**
* Read the five fields every commit record leads with, in the order
* `./index.ts` asks git for them.
* @param fields - one record split on the field separator.
* @returns those fields, or undefined when the record carries no object id.
*/
function commitHead(fields) {
	const oid = fields[0];
	if (oid === void 0 || oid === "") return void 0;
	return {
		oid,
		parents: fields[1] === void 0 || fields[1] === "" ? [] : fields[1].split(" "),
		authorName: fields[2] ?? "",
		authorEmail: fields[3] ?? "",
		authoredAt: fields[4] ?? ""
	};
}
/**
* Read the records of `log -z --format=<fields>`.
* @param output - the command's complete stdout.
* @returns one commit per record, with an empty decoration list.
*/
function parseLog(output) {
	const commits = [];
	for (const record of output.split(RECORD)) {
		if (record === "") continue;
		const fields = record.split(FIELD);
		const head = commitHead(fields);
		if (head === void 0) continue;
		commits.push({
			...head,
			subject: fields.slice(5).join(FIELD),
			refs: []
		});
	}
	return commits;
}
/**
* Read the records of `for-each-ref --format=<fields>`.
* @param output - the command's complete stdout, one ref per line.
* @returns one ref per record, in git's order.
*/
function parseRefs(output) {
	const refs = [];
	for (const line of output.split("\n")) {
		if (line === "") continue;
		const fields = line.split("	");
		const name = fields[0];
		const shortName = fields[1];
		if (name === void 0 || name === "" || shortName === void 0) continue;
		const kind = name.startsWith("refs/heads/") ? "local" : name.startsWith("refs/remotes/") ? "remote" : "tag";
		const objectOid = fields[3] ?? "";
		const peeledOid = fields[4] ?? "";
		refs.push({
			name,
			shortName,
			kind,
			oid: peeledOid === "" ? objectOid : peeledOid,
			head: fields[2] === "*",
			subject: (peeledOid === "" ? fields[5] : fields[6]) ?? "",
			committedAt: (peeledOid === "" ? fields[7] : fields[8]) ?? ""
		});
	}
	return refs;
}
/**
* Read `diff --no-color` output for one file.
*
* File headers before the first hunk are ignored: the caller already names the
* file it asked about. A `\ No newline at end of file` marker is dropped, since
* the panel renders lines rather than patching them.
* @param output - the command's complete stdout.
* @returns whether the pair is binary, and the hunks in file order.
*/
function parseUnifiedDiff(output) {
	const hunks = [];
	let binary = false;
	let current;
	for (const line of output.split("\n")) {
		if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
			binary = true;
			continue;
		}
		if (line.startsWith("@@")) {
			if (current !== void 0) hunks.push({
				header: current.header,
				lines: current.lines
			});
			current = {
				header: line,
				lines: []
			};
			continue;
		}
		if (current === void 0 || line === "" || line.startsWith("\\")) continue;
		const marker = line[0];
		const text = line.slice(1);
		if (marker === "+") current.lines.push({
			kind: "add",
			text
		});
		else if (marker === "-") current.lines.push({
			kind: "delete",
			text
		});
		else if (marker === " ") current.lines.push({
			kind: "context",
			text
		});
	}
	if (current !== void 0) hunks.push({
		header: current.header,
		lines: current.lines
	});
	return {
		binary,
		hunks
	};
}
/**
* Map one diff status letter onto a change's kind.
* @param letter - the first letter of a raw status or a name-status entry.
* @returns the matching kind; an unrecognized letter reports a modification.
*/
function changeKind(letter) {
	switch (letter) {
		case "A": return "added";
		case "D": return "deleted";
		case "R": return "renamed";
		case "C": return "copied";
		case "T": return "typechange";
		default: return "modified";
	}
}
/**
* Read the records of `diff-tree --raw -z`.
*
* Each record starts with the mode/object header and ends with the status, and
* the paths that follow it are their own NUL-separated fields: one for an
* ordinary change, previous then current for a rename or copy.
* @param output - the command's complete stdout.
* @returns one change per record, in git's order.
*/
function parseRawChanges(output) {
	const records = output.split(RECORD);
	const changes = [];
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		if (record === void 0 || !record.startsWith(":")) continue;
		const kind = changeKind(record.slice(record.lastIndexOf(" ") + 1)[0] ?? "M");
		if (kind === "renamed" || kind === "copied") {
			const from = records[index + 1];
			const to = records[index + 2];
			index += 2;
			if (from === void 0 || from === "" || to === void 0 || to === "") continue;
			changes.push({
				path: to,
				from,
				kind
			});
			continue;
		}
		const path = records[index + 1];
		index += 1;
		if (path === void 0 || path === "") continue;
		changes.push({
			path,
			kind
		});
	}
	return changes;
}
/**
* Read one `show --no-patch --format=<fields>` record.
* @param output - the command's complete stdout.
* @returns the commit, or undefined when the record carries no object id.
*/
function parseCommitDetail(output) {
	const fields = (output.endsWith("\n") ? output.slice(0, -1) : output).split(FIELD);
	const head = commitHead(fields);
	if (head === void 0) return void 0;
	return {
		...head,
		subject: fields[5] ?? "",
		body: fields.slice(6).join(FIELD).replace(/\n+$/u, "")
	};
}
/**
* Git Remote owner: locates the repository behind a registered Workspace and
* serves the history graph, working-tree status, refs, and file comparisons the
* Client panel renders.
*
* The Workspace registration is the only path authority. A request names a
* `WorkspaceId` and this Host resolves its canonical directory, so no caller can
* point the service at an arbitrary directory, and every path that crosses the
* wire is relative to the repository root and validated here. Every command runs
* through the subprocess seam with git's non-interactive environment, a
* per-command deadline, and a bounded stdout (see `@deepseek-ai/dsh-git-command`).
*
* Read-only: this service reports repository state and changes nothing in it.
*
* @module @deepseek-ai/dsh-api-git-controller
*/
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
/** Fields one `log` record carries, in the order `./porcelain.ts` reads them. */
const LOG_FORMAT = "%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s";
/** Fields one `show --no-patch` record carries; the body is last. */
const SHOW_FORMAT = "%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b";
/** Tab-separated fields of one `for-each-ref` line; the peeled forms are empty for a direct ref. */
const REF_FORMAT = [
	"%(refname)",
	"%(refname:short)",
	"%(HEAD)",
	"%(objectname)",
	"%(*objectname)",
	"%(subject)",
	"%(*subject)",
	"%(committerdate:iso-strict)",
	"%(*committerdate:iso-strict)"
].join("%09");
/** Refuse a wire number a request cannot use. */
function integerAtLeast(value, min, name) {
	if (!Number.isSafeInteger(value) || value < min) throw new RemoteError("gateway/bad-request", `${name} must be a safe integer of at least ${min}`, {});
	return value;
}
/**
* Validate one repository-relative path from the wire.
*
* The panel only ever sends a path git itself reported, so anything else is a
* defect or an attack: an absolute path or a `..` segment would leave the
* repository, and a NUL cannot travel through an argument at all.
* @param path - the path to validate.
* @returns the same path.
* @throws RemoteError with `git/bad-request` when the path is not repository-relative.
*/
function requireRelativePath(path) {
	if (path === "" || path.includes("\0") || path.startsWith("/") || path.startsWith("\\") || /^[a-z]:/iu.test(path) || path.split("/").includes("..")) throw new RemoteError("git/bad-request", `"${path}" is not a repository-relative path`, { reason: "path-outside-repository" });
	return path;
}
/**
* Validate one revision from the wire.
* @param revision - revision or refname to validate.
* @returns the same revision.
* @throws RemoteError with `git/bad-request` when it could be read as an option.
*/
function requireRevision(revision) {
	if (revision === "" || revision.includes("\0") || revision.startsWith("-")) throw new RemoteError("git/bad-request", `"${revision}" is not a usable revision`, { reason: "option-like-revision" });
	return revision;
}
/**
* Validate one object id from the wire.
* @param oid - object id to validate.
* @returns the same object id.
* @throws RemoteError with `git/bad-request` when it is not hexadecimal.
*/
function requireObjectId(oid) {
	if (!/^[0-9a-f]{4,64}$/iu.test(oid)) throw new RemoteError("git/bad-request", `"${oid}" is not a commit id`, { reason: "option-like-revision" });
	return oid;
}
/**
* A one-slot async wakeup: pushes coalesce while nobody is waiting, and a
* waiter resolves on the next push or rejects on abort.
* @returns the queue's one operation: wait for the next push.
*/
function createWakeQueue() {
	let waiting;
	let pending = false;
	return {
		push: () => {
			if (waiting === void 0) {
				pending = true;
				return;
			}
			const resolve = waiting;
			waiting = void 0;
			resolve();
		},
		next: (signal) => new Promise((resolve, reject) => {
			if (pending) {
				pending = false;
				resolve();
				return;
			}
			const abort = () => {
				waiting = void 0;
				reject(signal.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("aborted"));
			};
			signal.addEventListener("abort", abort, { once: true });
			waiting = () => {
				signal.removeEventListener("abort", abort);
				resolve();
			};
		})
	};
}
/** Host Remote owner of the `git` namespace. */
let GitController = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _repository_decorators;
	let _status_decorators;
	let _refs_decorators;
	let _log_decorators;
	let _commit_decorators;
	let _diff_decorators;
	let _watch_decorators;
	return class GitController extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_repository_decorators = [Remote];
			_status_decorators = [Remote];
			_refs_decorators = [Remote];
			_log_decorators = [Remote];
			_commit_decorators = [Remote];
			_diff_decorators = [Remote];
			_watch_decorators = [Remote({ mode: "stream" })];
			__esDecorate(this, null, _repository_decorators, {
				kind: "method",
				name: "repository",
				static: false,
				private: false,
				access: {
					has: (obj) => "repository" in obj,
					get: (obj) => obj.repository
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _status_decorators, {
				kind: "method",
				name: "status",
				static: false,
				private: false,
				access: {
					has: (obj) => "status" in obj,
					get: (obj) => obj.status
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _refs_decorators, {
				kind: "method",
				name: "refs",
				static: false,
				private: false,
				access: {
					has: (obj) => "refs" in obj,
					get: (obj) => obj.refs
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _log_decorators, {
				kind: "method",
				name: "log",
				static: false,
				private: false,
				access: {
					has: (obj) => "log" in obj,
					get: (obj) => obj.log
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _commit_decorators, {
				kind: "method",
				name: "commit",
				static: false,
				private: false,
				access: {
					has: (obj) => "commit" in obj,
					get: (obj) => obj.commit
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _diff_decorators, {
				kind: "method",
				name: "diff",
				static: false,
				private: false,
				access: {
					has: (obj) => "diff" in obj,
					get: (obj) => obj.diff
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _watch_decorators, {
				kind: "method",
				name: "watch",
				static: false,
				private: false,
				access: {
					has: (obj) => "watch" in obj,
					get: (obj) => obj.watch
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		config = __runInitializers(this, _instanceExtraInitializers);
		static inject = [
			"fs",
			"subprocess",
			"workspaceRegistry"
		];
		static Config = z.object({
			timeoutMs: z.number().step(1).min(1).default(3e4),
			outputMaxBytes: z.number().step(1).min(1).default(8 * 1024 * 1024),
			maxRefs: z.number().step(1).min(1).default(2e3),
			maxStatusEntries: z.number().step(1).min(1).default(5e3),
			maxLogPage: z.number().step(1).min(1).default(200),
			maxCommitFiles: z.number().step(1).min(1).default(1e3)
		});
		/** Cancels every command this plugin's lifetime owns. */
		lifetime = new AbortController();
		/** Resolved once per plugin lifetime; a rejected resolution is retried by the next request. */
		resolution;
		/**
		* @param ctx - Host context carrying the process seam and the Workspace registry.
		* @param config - deployment bounds on one call.
		*/
		constructor(ctx, config) {
			super(ctx, "gitController", { namespace: "git" });
			this.config = config;
			for (const [field, value] of Object.entries(config)) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`git-controller requires a positive integer ${field}`);
			ctx.effect(() => () => {
				this.lifetime.abort();
			}, "git-controller: command lifetime");
		}
		/**
		* Locate the repository that contains a Workspace's directory.
		* @param workspaceId - registered Workspace whose directory is searched.
		* @param signal - caller cancellation.
		* @returns the located working tree, or `not-a-repository` when the directory is outside one.
		* @throws RemoteError when no such Workspace is registered.
		*/
		async repository(workspaceId, signal) {
			const located = await this.locate(workspaceId, signal);
			if (located === void 0) return { kind: "not-a-repository" };
			const status = await (await this.requireRunner()).run([
				"status",
				"--porcelain=v2",
				"--branch",
				"-z",
				"--untracked-files=no"
			], {
				cwd: located.root,
				signal
			});
			if (status.exitCode !== 0) throw this.failure("status", status);
			const facts = parseBranchFacts(status.stdout);
			return {
				kind: "repository",
				repository: {
					root: located.root,
					name: basename(located.root),
					head: facts.head,
					...facts.upstream === void 0 ? {} : { upstream: facts.upstream }
				}
			};
		}
		/**
		* Read the working tree's changed paths, each with its staged and unstaged sides.
		* @param workspaceId - registered Workspace whose repository is read.
		* @param signal - caller cancellation.
		* @returns the changed paths, cut to the configured cap.
		*/
		async status(workspaceId, signal) {
			const located = await this.requireRepository(workspaceId, signal);
			const result = await (await this.requireRunner()).run([
				"status",
				"--porcelain=v2",
				"-z",
				"--untracked-files=all"
			], {
				cwd: located.root,
				signal
			});
			if (result.exitCode !== 0) throw this.failure("status", result);
			const entries = parseStatusEntries(result.stdout);
			const cap = this.config.maxStatusEntries;
			return {
				entries: entries.slice(0, cap),
				truncated: entries.length > cap
			};
		}
		/**
		* Read every branch, remote-tracking ref, and tag.
		* @param workspaceId - registered Workspace whose repository is read.
		* @param signal - caller cancellation.
		* @returns the refs, cut to the configured cap.
		*/
		async refs(workspaceId, signal) {
			const located = await this.requireRepository(workspaceId, signal);
			const refs = await this.readRefs(located.root, signal);
			const cap = this.config.maxRefs;
			return {
				refs: refs.slice(0, cap),
				truncated: refs.length > cap
			};
		}
		/**
		* Walk the history from one revision, newest first, decorating each commit with the refs that point at it.
		* @param workspaceId - registered Workspace whose repository is read.
		* @param request - revision, window, and optional path filter.
		* @param signal - caller cancellation.
		* @returns one page of commits and whether the walk continues.
		*/
		async log(workspaceId, request, signal) {
			const located = await this.requireRepository(workspaceId, signal);
			const runner = await this.requireRunner();
			const cap = this.config.maxLogPage;
			const requested = request.limit === void 0 ? cap : integerAtLeast(request.limit, 1, "limit");
			if (requested > cap) throw new RemoteError("gateway/bad-request", `limit must be at most ${cap}`, {});
			const skip = request.skip === void 0 ? 0 : integerAtLeast(request.skip, 0, "skip");
			const revision = request.rev === void 0 || request.rev === "" ? "HEAD" : requireRevision(request.rev);
			const path = request.path === void 0 ? void 0 : requireRelativePath(request.path);
			const args = [
				"log",
				"-z",
				"--date-order",
				`--max-count=${requested + 1}`,
				`--skip=${skip}`,
				`--format=${LOG_FORMAT}`,
				revision
			];
			if (path !== void 0) args.push("--", path);
			const result = await runner.run(args, {
				cwd: located.root,
				signal
			});
			if (result.exitCode !== 0) {
				if (/does not have any commits yet/i.test(result.stderr)) return {
					commits: [],
					more: false
				};
				if (revision === "HEAD" && /ambiguous argument 'HEAD'/iu.test(result.stderr)) return {
					commits: [],
					more: false
				};
				throw /unknown revision|bad revision|ambiguous argument/i.test(result.stderr) ? new RemoteError("git/unknown-revision", `no revision "${revision}"`, { revision }) : this.failure("log", result);
			}
			const parsed = parseLog(result.stdout);
			const more = parsed.length > requested;
			const decorations = await this.decorations(located.root, signal);
			return {
				commits: parsed.slice(0, requested).map((commit) => ({
					...commit,
					refs: decorations.get(commit.oid) ?? []
				})),
				more
			};
		}
		/**
		* Read one commit's message, metadata, and complete file list.
		* @param workspaceId - registered Workspace whose repository is read.
		* @param oid - commit id to read.
		* @param signal - caller cancellation.
		* @returns the commit and its changed files, cut to the configured cap.
		*/
		async commit(workspaceId, oid, signal) {
			const located = await this.requireRepository(workspaceId, signal);
			const runner = await this.requireRunner();
			const revision = requireObjectId(oid);
			const shown = await runner.run([
				"show",
				"--no-patch",
				`--format=${SHOW_FORMAT}`,
				revision
			], {
				cwd: located.root,
				signal
			});
			if (shown.exitCode !== 0) throw /unknown revision|bad object|ambiguous argument|invalid object name/i.test(shown.stderr) ? new RemoteError("git/unknown-revision", `no commit "${revision}"`, { revision }) : this.failure("show", shown);
			const parsed = parseCommitDetail(shown.stdout);
			if (parsed === void 0) throw new RemoteError("git/unknown-revision", `no commit "${revision}"`, { revision });
			const files = await this.readFileChanges(located.root, revision, signal);
			const cap = this.config.maxCommitFiles;
			const decorations = await this.decorations(located.root, signal);
			return {
				...parsed,
				parents: [...parsed.parents],
				refs: decorations.get(parsed.oid) ?? [],
				files: files.slice(0, cap),
				filesTruncated: files.length > cap
			};
		}
		/**
		* Compare one file between two of its states.
		* @param workspaceId - registered Workspace whose repository is read.
		* @param request - the path, an optional pre-rename path, and which two states to compare.
		* @param signal - caller cancellation.
		* @returns the comparison, or an explicit untracked result when the working tree has no index entry for it.
		*/
		async diff(workspaceId, request, signal) {
			const located = await this.requireRepository(workspaceId, signal);
			const runner = await this.requireRunner();
			const path = requireRelativePath(request.path);
			const from = request.from === void 0 ? void 0 : requireRelativePath(request.from);
			const paths = from === void 0 ? [path] : [from, path];
			const base = {
				path,
				...from === void 0 ? {} : { from }
			};
			const side = request.side;
			let result;
			switch (side.kind) {
				case "worktree": {
					const tracked = await runner.run([
						"ls-files",
						"--error-unmatch",
						"--",
						path
					], {
						cwd: located.root,
						signal
					});
					if (tracked.exitCode === 1) return {
						...base,
						hunks: [],
						binary: false,
						untracked: true,
						truncated: false
					};
					if (tracked.exitCode !== 0) throw this.failure("ls-files", tracked);
					result = await runner.run([
						"diff",
						"--no-color",
						"-M",
						"--",
						...paths
					], {
						cwd: located.root,
						signal
					});
					break;
				}
				case "index":
					result = await runner.run([
						"diff",
						"--cached",
						"--no-color",
						"-M",
						"--",
						...paths
					], {
						cwd: located.root,
						signal
					});
					break;
				case "commit":
					result = await runner.run([
						"show",
						"--no-color",
						"-M",
						"--format=",
						requireObjectId(side.oid),
						"--",
						...paths
					], {
						cwd: located.root,
						signal
					});
					break;
				default: return assertNever(side);
			}
			if (result.exitCode !== 0) throw this.failure("diff", result);
			const parsed = parseUnifiedDiff(result.stdout);
			return {
				...base,
				hunks: parsed.hunks,
				binary: parsed.binary,
				untracked: false,
				truncated: result.truncated
			};
		}
		/** Resolve the executable once, and cancel the resolution with the plugin. */
		resolveRunner() {
			this.resolution ??= this.resolveOnce();
			return this.resolution;
		}
		async resolveOnce() {
			try {
				const resolved = await resolveGitExecutable(this.ctx.subprocess, this.lifetime.signal);
				if ("reason" in resolved) return {
					kind: "unavailable",
					reason: resolved.reason
				};
				return {
					kind: "runner",
					runner: new GitRunner(this.ctx.subprocess, resolved.executable, {
						timeoutMs: this.config.timeoutMs,
						outputMaxBytes: this.config.outputMaxBytes
					})
				};
			} catch (error) {
				this.resolution = void 0;
				throw error;
			}
		}
		/** The runner, or the explicit refusal the Client renders as "git is unavailable". */
		async requireRunner() {
			const resolution = await this.resolveRunner();
			if (resolution.kind === "unavailable") throw new RemoteError("git/unavailable", `git is unavailable (${resolution.reason})`, { reason: resolution.reason });
			return resolution.runner;
		}
		/** Resolve one Workspace's canonical directory; the registration is the only path authority. */
		workspacePath(workspaceId) {
			const workspace = this.ctx.workspaceRegistry.get(workspaceId);
			if (workspace === void 0) throw new RemoteError("workspace/not-found", `no workspace "${workspaceId}"`, { workspaceId });
			return workspace.path;
		}
		/** Locate the working tree containing a Workspace, or undefined when it is outside every repository. */
		/**
		* Watch the repository's own directory for the changes that make a read
		* stale: a commit, a checkout, an index write. A Workspace without a
		* repository ends the stream instead of failing, so a caller may start it
		* before it knows one exists.
		* @param workspaceId - registered Workspace to watch.
		* @param signal - generation cancellation.
		* @returns `ready` once the watch is active, then one frame per invalidation.
		*/
		async *watch(workspaceId, signal) {
			const located = await this.locate(workspaceId, signal).catch(() => void 0);
			if (located === void 0) return;
			const workspace = await this.ctx.fs.resolve(this.workspacePath(workspaceId), { signal });
			const directory = await this.ctx.fs.resolve(join(located.root, ".git"), { signal });
			if (!((await this.ctx.fs.stat(directory, signal))?.type === "directory" && this.ctx.fs.contains(workspace, directory))) return;
			const wake = createWakeQueue();
			const unwatch = await this.ctx.fs.watch(directory, (error) => {
				if (error === void 0) wake.push();
			}, signal).catch(() => void 0);
			if (unwatch === void 0) return;
			yield { kind: "ready" };
			try {
				while (!signal.aborted) {
					await wake.next(signal);
					yield { kind: "change" };
				}
			} finally {
				await unwatch();
			}
		}
		async locate(workspaceId, signal) {
			const result = await (await this.requireRunner()).run(["rev-parse", "--show-toplevel"], {
				cwd: this.workspacePath(workspaceId),
				signal
			});
			if (result.exitCode === 0) {
				const root = result.stdout.split("\n")[0];
				if (root === void 0 || root === "") throw this.failure("rev-parse", result);
				return { root };
			}
			if (result.exitCode === 128 && /not a git repository/i.test(result.stderr)) return void 0;
			throw this.failure("rev-parse", result);
		}
		/** Locate the working tree, or refuse the call as one made outside a repository. */
		async requireRepository(workspaceId, signal) {
			const located = await this.locate(workspaceId, signal);
			if (located === void 0) throw new RemoteError("git/not-a-repository", `workspace "${workspaceId}" is outside every git repository`, { workspaceId });
			return located;
		}
		/** Every ref, whether or not the caller keeps all of them. */
		async readRefs(root, signal) {
			const result = await (await this.requireRunner()).run(["for-each-ref", `--format=${REF_FORMAT}`], {
				cwd: root,
				signal
			});
			if (result.exitCode !== 0) throw this.failure("for-each-ref", result);
			return parseRefs(result.stdout);
		}
		/** Short ref names by the commit they point at, for decorating a history page. */
		async decorations(root, signal) {
			const byOid = /* @__PURE__ */ new Map();
			for (const ref of await this.readRefs(root, signal)) {
				const names = byOid.get(ref.oid);
				if (names === void 0) byOid.set(ref.oid, [ref.shortName]);
				else names.push(ref.shortName);
			}
			return byOid;
		}
		/** One commit's changed files: line counts from `--numstat`, kinds from `--raw`. */
		async readFileChanges(root, revision, signal) {
			const runner = await this.requireRunner();
			const shared = [
				"-r",
				"-M",
				"-z",
				"--no-commit-id",
				"--root",
				revision
			];
			const stats = await runner.run([
				"diff-tree",
				"--numstat",
				...shared
			], {
				cwd: root,
				signal
			});
			if (stats.exitCode !== 0) throw this.failure("diff-tree", stats);
			if (stats.truncated) throw this.outputCut("diff-tree");
			const raw = await runner.run([
				"diff-tree",
				"--raw",
				...shared
			], {
				cwd: root,
				signal
			});
			if (raw.exitCode !== 0) throw this.failure("diff-tree", raw);
			const kinds = new Map(parseRawChanges(raw.stdout).map((change) => [change.path, change.kind]));
			return parseNumstat(stats.stdout).map((entry) => ({
				path: entry.path,
				...entry.oldPath === void 0 ? {} : { from: entry.oldPath },
				kind: kinds.get(entry.path) ?? (entry.oldPath === void 0 ? "modified" : "renamed"),
				insertions: entry.added,
				deletions: entry.deleted,
				binary: entry.binary
			}));
		}
		/** The wire failure for a command that exited nonzero or was killed. */
		failure(command, result) {
			return new RemoteError("git/command-failed", `git ${command} failed: ${result.stderr.trim() === "" ? `exit ${String(result.exitCode)}` : result.stderr.trim()}`, { command });
		}
		/** The wire failure for a command whose stdout the configured cap cut short, which no parser can read. */
		outputCut(command) {
			return new RemoteError("git/command-failed", `git ${command} failed: stdout exceeded the configured output cap`, { command });
		}
	};
})();
//#endregion
export { GitController, GitController as default };
