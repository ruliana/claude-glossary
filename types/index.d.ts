// The `$.state` contract of the glossary plugin: plain data the host holds for
// the session, which survives a hot reload of the plugin's code.

/** One glossary entry as the browser pane shows it (no compiled matcher). */
export type GlossaryPaneEntry = {
	term: string;
	definition: string;
	aliases: string[];
	source: string;
};

declare module 'claude-code' {
	interface PluginState {
		glossary: {
			/** Entries of the loaded glossary, for the `/glossary` pane. */
			entries: GlossaryPaneEntry[];
			/** Terms whose definitions are already in this session's context. */
			loaded: string[];
			/** Whether the preamble has already been injected this session. */
			hasPreamble: boolean;
			/** The pane's search text. */
			query: string;
			/** The term shown in the pane's details column, if any. */
			selected: string | null;
			/** Fatal load error, shown by the pane and `/glossary`. */
			error: string | null;
		};
	}
}
