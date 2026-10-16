#!/bin/sh
# inloop's reader guard: a PreToolUse hook in force only while inloop's reader
# agent runs. The reader may only read inside the project: read-only git, file
# searches and reads, never secrets files and never paths outside the project.
# Claude Code passes the call as JSON on stdin; exit 2 refuses it, with the
# reason on stderr for the agent to read.

input=$(cat)

deny() {
  echo "inloop's reader only reads: $1" >&2
  exit 2
}

# The value of a JSON string field, unescaped enough to check (\" and \\ only).
field() {
  printf '%s' "$input" | tr '\n' ' ' | sed -nE 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)".*/\1/p' | head -n 1 | sed 's/\\"/"/g; s/\\\\/\\/g'
}

tool=$(field tool_name)
cwd=$(field cwd)
[ -n "$cwd" ] || cwd=$(pwd)
cwd=${cwd%/}

# Secrets files, by name, anywhere in the call.
secret='(^|[/[:space:]"'"'"'=])(\.env([.][^/[:space:]"'"'"']*)?|\.envrc|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.htpasswd|(credentials|secrets?)\.[a-z]+|[^/[:space:]]*\.(pem|key|p12|pfx|jks|keystore|asc|gpg)|service[-_]?account[^/[:space:]]*\.json)([[:space:]"'"'"']|$)|(^|/)\.(aws|ssh|gnupg|docker)(/|$)|/(credentials|secrets?)([[:space:]"'"'"']|$)'

# Every path in the call must be inside the project.
check_paths() {
  if printf '%s' "$1" | grep -qE '(^|[[:space:]/"'"'"'=])\.\.(/|[[:space:]"'"'"']|$)'; then deny "paths may not climb out of the project."; fi
  for p in $(printf '%s' "$1" | grep -oE '(^|[[:space:]"'"'"'=])(/|~)[^[:space:]"'"'"';|&]*' | sed -E 's/^[[:space:]"'"'"'=]//'); do
    case "$p" in "~"*) p="$HOME${p#\~}" ;; esac
    case "$p" in *..*) deny "paths may not climb out of the project." ;; esac
    case "$p" in
      "$cwd" | "$cwd"/*) ;;
      # A search pattern such as /api/login is no path: only real places outside count.
      *) if [ -e "$p" ]; then deny "$p is outside the project."; fi ;;
    esac
  done
}

case "$tool" in
  # How the reader hands its answer back to inloop.
  SubagentHandback | StructuredOutput)
    exit 0
    ;;
  Read | Glob | Grep | LS | NotebookRead)
    target="$(field file_path) $(field path) $(field pattern) $(field notebook_path)"
    if printf '%s' "$target" | grep -qE "$secret"; then deny "secrets files are off limits."; fi
    check_paths "$target"
    exit 0
    ;;
  Bash)
    cmd=$(field command)
    # Leaving secrets files out of a search is fine: --exclude=.env names one without reading it.
    named=$(printf '%s' "$cmd" | sed -E 's/--exclude(-dir)?=("[^"]*"|'"'"'[^'"'"']*'"'"'|[^[:space:]]*)//g')
    if printf '%s' "$named" | grep -qE "$secret"; then deny "secrets files are off limits."; fi
    check_paths "$cmd"
    # Double quotes do not stop substitution, so it is refused wherever it appears.
    case "$cmd" in *'`'* | *'$('*) deny "no command substitution." ;; esac
    # Otherwise quoted text (search patterns) is no shell syntax: blank it before reading the command's shape.
    shape=$(printf '%s' "$cmd" | sed -E 's/"([^"\\]|\\.)*"/Q/g; s/'"'"'[^'"'"']*'"'"'/Q/g')
    # No chaining, substitution or redirection; `cd <project> &&` at the start is fine.
    rest=$(printf '%s' "$shape" | sed -E 's/^[[:space:]]*cd[[:space:]]+[^;&|]*[[:space:]]*&&[[:space:]]*//')
    case "$rest" in
      *';'* | *'&'* | *'`'* | *'$('* | *'>'* | *'<'* | *'
'*) deny "no chaining, substitution or redirection." ;;
    esac
    # Each piece of a pipeline reads only.
    IFS='|'
    first=1
    for piece in $rest; do
      piece=$(printf '%s' "$piece" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
      if [ "$first" = 1 ]; then
        first=0
        if printf '%s' "$piece" | grep -qE '^git([[:space:]]+(--no-pager|-c[[:space:]]+[^[:space:]]+|-C[[:space:]]+[^[:space:]]+))*[[:space:]]+(log|show|diff|blame|grep|ls-files|ls-tree|rev-parse|cat-file|shortlog|describe|status)([[:space:]]|$)'; then
          if printf '%s' "$piece" | grep -qE '[[:space:]]--(output|exec|ext-diff|textconv)'; then deny "that git option writes or runs things."; fi
        elif printf '%s' "$piece" | grep -qE '^(rg|ugrep|ag|ack)([[:space:]]|$)' || printf '%s' "$piece" | grep -qE '^(grep|egrep|fgrep)[[:space:]].*(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--dereference-recursive)([[:space:]]|$)'; then
          # A tree-wide search reads every file, secrets files too: git grep searches only tracked files.
          deny "to search the whole project use git grep (it searches tracked files only); grep is fine on named files."
        elif printf '%s' "$piece" | grep -qE '^(grep|egrep|fgrep|ls|find|bfs|cat|head|tail|wc|file|stat|tree)([[:space:]]|$)'; then
          if printf '%s' "$piece" | grep -qE '[[:space:]]-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls)([[:space:]]|$)'; then deny "find may not run or delete anything."; fi
        else
          deny "only read-only git and file reading or searching commands may run."
        fi
      else
        printf '%s' "$piece" | grep -qE '^(head|tail|grep|egrep|wc|sort|uniq|cut|tr|nl)([[:space:]]|$)' || deny "output may only be piped into head, tail, grep, wc, sort, uniq or cut."
      fi
    done
    exit 0
    ;;
  *)
    deny "$tool is not allowed."
    ;;
esac
