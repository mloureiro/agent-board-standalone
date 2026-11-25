export const SHELLS = ['bash', 'zsh', 'fish'] as const;
export type Shell = (typeof SHELLS)[number];

export const SCHEDULE_VERBS = ['pause', 'resume', 'rm', 'edit'] as const;
export const LOG_UNITS = ['dispatch', 'listen', 'watch'] as const;

export interface CompletionTree {
  readonly commands: readonly string[];
  readonly taskCommands: readonly string[];
}

function bash(tree: CompletionTree): string {
  return `# board completion for bash: source it, or save it in a bash-completion directory
_board() {
  local cur prev words cword profile=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  local i
  for ((i = 1; i < COMP_CWORD; i++)); do
    if [[ "\${COMP_WORDS[i]}" == "--profile" ]]; then profile=(--profile "\${COMP_WORDS[i+1]}"); fi
  done
  local sub=""
  for ((i = 1; i < COMP_CWORD; i++)); do
    case "\${COMP_WORDS[i]}" in
      --profile) i=$((i + 1)) ;;
      -*) ;;
      *) sub="\${COMP_WORDS[i]}"; break ;;
    esac
  done
  if [[ -z "$sub" ]]; then
    COMPREPLY=($(compgen -W "${tree.commands.join(' ')}" -- "$cur"))
    return
  fi
  case "$sub" in
    ${tree.taskCommands.join('|')})
      COMPREPLY=($(compgen -W "$(board "\${profile[@]}" __complete tasks 2>/dev/null)" -- "$cur")) ;;
    logs)
      COMPREPLY=($(compgen -W "${LOG_UNITS.join(' ')} $(board "\${profile[@]}" __complete tasks 2>/dev/null)" -- "$cur")) ;;
    schedules)
      case "$prev" in
        ${SCHEDULE_VERBS.join('|')})
          COMPREPLY=($(compgen -W "$(board "\${profile[@]}" __complete schedules 2>/dev/null)" -- "$cur")) ;;
        *) COMPREPLY=($(compgen -W "list ${SCHEDULE_VERBS.join(' ')}" -- "$cur")) ;;
      esac ;;
  esac
}
complete -F _board board
`;
}

function zsh(tree: CompletionTree): string {
  return `#compdef board
# board completion for zsh: save it as _board in a directory of $fpath
_board() {
  local -a profile
  local sub="" i
  for ((i = 2; i < CURRENT; i++)); do
    case "\${words[i]}" in
      --profile) profile=(--profile "\${words[i+1]}"); i=$((i + 1)) ;;
      -*) ;;
      *) sub="\${words[i]}"; break ;;
    esac
  done
  if [[ -z "$sub" ]]; then
    compadd -- ${tree.commands.join(' ')}
    return
  fi
  case "$sub" in
    ${tree.taskCommands.join('|')})
      compadd -- \${(f)"$(board "\${profile[@]}" __complete tasks 2>/dev/null)"} ;;
    logs)
      compadd -- ${LOG_UNITS.join(' ')} \${(f)"$(board "\${profile[@]}" __complete tasks 2>/dev/null)"} ;;
    schedules)
      case "\${words[CURRENT-1]}" in
        ${SCHEDULE_VERBS.join('|')})
          compadd -- \${(f)"$(board "\${profile[@]}" __complete schedules 2>/dev/null)"} ;;
        *) compadd -- list ${SCHEDULE_VERBS.join(' ')} ;;
      esac ;;
  esac
}
compdef _board board
`;
}

function fish(tree: CompletionTree): string {
  const verbs = SCHEDULE_VERBS.join(' ');
  return `# board completion for fish: save it as board.fish in ~/.config/fish/completions
complete -c board -f
complete -c board -n '__fish_use_subcommand' -a '${tree.commands.join(' ')}'
complete -c board -n '__fish_seen_subcommand_from ${tree.taskCommands.join(' ')}' -a '(board __complete tasks 2>/dev/null)'
complete -c board -n '__fish_seen_subcommand_from logs' -a '${LOG_UNITS.join(' ')} (board __complete tasks 2>/dev/null)'
complete -c board -n '__fish_seen_subcommand_from schedules; and not __fish_seen_subcommand_from ${verbs}' -a 'list ${verbs}'
complete -c board -n '__fish_seen_subcommand_from schedules; and __fish_seen_subcommand_from ${verbs}' -a '(board __complete schedules 2>/dev/null)'
`;
}

export function completionScript(shell: Shell, tree: CompletionTree): string {
  if (shell === 'bash') return bash(tree);
  if (shell === 'zsh') return zsh(tree);
  return fish(tree);
}
