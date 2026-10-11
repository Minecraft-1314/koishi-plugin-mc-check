import type { Command, Context } from 'koishi'

export function registerCommand(
  ctx: Context,
  definition: string,
  description: string,
  configure: (command: Command) => void,
): Command {
  const path = definition.split(' ', 1)[0]
  const name = path.toLowerCase().replace(/_/g, '-')
  if (ctx.$commander.get(name)) {
    throw new Error(`duplicate command: ${name}`)
  }
  let command: Command | undefined
  try {
    command = ctx.command(definition, description)
    configure(command)
    if (!(command as any)._actions?.length) {
      throw new Error(`command has no action: ${name}`)
    }
    return command
  } catch (error) {
    const registered = command || ctx.$commander.get(name)
    if (registered) registered.dispose()
    throw error
  }
}
