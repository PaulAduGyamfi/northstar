// The few Chrome extension APIs this extension calls, typed by hand instead of adding
// @types/chrome (NS-128: no new dependency). Only what popup.ts and options.ts use.
declare namespace chrome {
  namespace storage {
    const local: {
      get(keys: string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, string>): Promise<void>;
    };
  }
  namespace tabs {
    // `url` is set only while activeTab grants the tab, after Paul's click.
    type Tab = { id?: number; url?: string };
    function query(query: { active: true; currentWindow: true }): Promise<Tab[]>;
  }
  namespace scripting {
    function executeScript<T>(injection: {
      target: { tabId: number };
      func: () => T;
    }): Promise<{ result?: T }[]>;
    // With arguments, into chosen frames (frame 0 is the tab's main frame).
    function executeScript<A extends unknown[], T>(injection: {
      target: { tabId: number; frameIds?: number[] };
      func: (...args: A) => T;
      args: A;
    }): Promise<{ result?: T }[]>;
  }
}
