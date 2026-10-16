#!/bin/sh
# Checks hooks/reader-guard.sh against calls it must allow and refuse:
#   sh tests/reader-guard.test.sh
guard="$(dirname "$0")/../hooks/reader-guard.sh"
root=/repo/proj
fails=0
check() {
  want=$1 tool=$2 input=$3
  printf '{"tool_name":"%s","tool_input":%s,"cwd":"%s","hook_event_name":"PreToolUse"}' "$tool" "$input" "$root" | sh "$guard" 2>/dev/null
  got=$?
  if [ "$got" != "$want" ]; then fails=$((fails + 1)); echo "FAIL (got $got, want $want): $tool $input"; fi
}
allow() { check 0 "$@"; }
refuse() { check 2 "$@"; }

allow Bash '{"command":"git log --oneline -20"}'
allow Bash '{"command":"git log HEAD~3..HEAD --stat"}'
allow Bash '{"command":"git show --stat HEAD HEAD~1 | head -80"}'
allow Bash '{"command":"cd /repo/proj && git show HEAD"}'
refuse Bash '{"command":"grep -rn \"apiKey\" /repo/proj/src --exclude=keys.ts | head -20"}'
refuse Bash '{"command":"grep -rn KEY ."}'
refuse Bash '{"command":"rg password"}'
allow Bash '{"command":"git grep -n KEY"}'
allow Bash '{"command":"grep -n listen src/app.ts"}'
allow Bash '{"command":"grep -n \"/api/login\" src/app.ts"}'
allow Bash '{"command":"find src -name \"*.ts\" | wc -l"}'
allow Bash '{"command":"ls -la"}'
allow Bash '{"command":"cat src/app.ts | head -50"}'
allow Read '{"file_path":"/repo/proj/src/app.ts"}'
allow Grep '{"pattern":"token","path":"/repo/proj/src"}'
allow Glob '{"pattern":"**/*.ts"}'
allow Bash '{"command":"grep -n \"SPIN_MS\" --exclude=.env src/app.ts"}'
allow SubagentHandback '{"message":"{\"answer\":\"ok\"}"}'
allow Bash '{"command":"git grep -n -i \"redact\\\\|secret\" -- src hooks | head -40"}'
allow Bash '{"command":"git grep -n -e redact -e secret -- src"}'
allow Bash '{"command":"git -C /repo/proj log -3"}'
allow Bash '{"command":"git grep -n \"process.env\""}'
refuse Bash '{"command":"git -C /etc log"}'
refuse Bash '{"command":"cat config/secrets.yml"}'
refuse Bash '{"command":"cat deploy/credentials"}'
refuse Bash '{"command":"git log \"x\" ; rm -rf ."}'
refuse Bash '{"command":"git grep \"$(rm -rf .)\""}'
refuse Bash '{"command":"git grep \"`rm -rf .`\""}'
refuse Bash '{"command":"rm -rf src"}'
refuse Bash '{"command":"npm test"}'
refuse Bash '{"command":"python3 -c \"print(1)\""}'
refuse Bash '{"command":"git commit -am x"}'
refuse Bash '{"command":"git checkout main"}'
refuse Bash '{"command":"git diff --output=/tmp/x"}'
refuse Bash '{"command":"git log; rm -rf /"}'
refuse Bash '{"command":"git log | sh"}'
refuse Bash '{"command":"git log > out.txt"}'
refuse Bash '{"command":"echo $(whoami)"}'
refuse Bash '{"command":"find . -name x -delete"}'
refuse Bash '{"command":"find . -exec rm {} \;"}'
refuse Bash '{"command":"cat .env"}'
refuse Bash '{"command":"grep -r KEY .env.local"}'
refuse Bash '{"command":"cat ~/.ssh/id_rsa"}'
refuse Bash '{"command":"cat /etc/passwd"}'
refuse Bash '{"command":"ls ../"}'
refuse Read '{"file_path":"/repo/proj/.env"}'
refuse Read '{"file_path":"/repo/proj/config/secrets.json"}'
refuse Read '{"file_path":"/repo/proj/certs/server.pem"}'
refuse Read '{"file_path":"/etc/hosts"}'
refuse Edit '{"file_path":"/repo/proj/src/app.ts","old_string":"a","new_string":"b"}'
refuse Write '{"file_path":"/repo/proj/x","content":"y"}'

if [ "$fails" = 0 ]; then echo "reader guard: all cases pass"; else echo "reader guard: $fails failing"; exit 1; fi
