interface Handler {
  (...args: any[]): unknown;
}
export function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, { handler: Handler }>();
  const shortcuts = new Map<string, { handler: Handler }>();
  const widgets = new Map<string, any>();
  const notifications: string[] = [];
  const messages: any[] = [];
  const entries: any[] = [];
  const menuChoices: Array<string | undefined> = [];
  const settingChoices: Array<string | undefined> = [];
  const numericValues: string[] = [];
  const events = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const current = handlers.get(event) ?? [];
        handlers.set(event, current.filter(item => item !== handler));
      };
    },
    emit(event: string, data: unknown) {
      for (const handler of [...(handlers.get(event) ?? [])]) void handler(data);
    },
  };
  const pi = {
    events,
    registerMessageRenderer: () => {},
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: { handler: Handler }) => commands.set(name, command),
    registerShortcut: (name: string, shortcut: { handler: Handler }) => shortcuts.set(name, shortcut),
    on: (event: string, handler: Handler) => events.on(event, handler),
    sendMessage: (message: any) => { messages.push(message); },
    appendEntry: (customType: string, data: any) => { entries.push({ customType, data }); },
  };
  const ui: any = {
    theme: {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    },
    setWidget: (key: string, content: any) => {
      if (content === undefined) widgets.delete(key);
      else widgets.set(key, content);
    },
    setStatus: () => {},
    onTerminalInput: () => () => {},
    notify: (message: string) => notifications.push(message),
    select: async () => menuChoices.shift(),
    input: async () => numericValues.shift(),
  };
  ui.custom = async (factory: any) => {
    factory({}, ui.theme, {}, () => {});
    // The settings overlay is behavioral here; choose the next field without
    // depending on SettingsList's terminal rendering.
    return settingChoices.shift();
  };
  return { messages, entries, pi, tools, commands, shortcuts, widgets, handlers, ui, notifications, menuChoices, settingChoices, numericValues };
}

export function context(cwd: string, ui: any): any {
  return {
    cwd,
    ui,
    hasUI: true,
    model: undefined,
    modelRegistry: {},
    sessionManager: {
      getSessionId: () => "ctrl-b-test-session",
      getSessionFile: () => undefined,
    },
  };
}
