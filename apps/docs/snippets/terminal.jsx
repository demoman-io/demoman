// A static terminal, drawn like the site's hero pane. Styles in /style.css
// (.dm-term). Each line is a string; its start picks its look:
//   "> …"  what you typed      "⏺ name …"  a tool call (name coloured)
//   "  ⎿ …" a tool's answer     anything else: plain output
// Copy lines from a real run; never invent output.
export const Terminal = ({ title = "", lines = [] }) => {
  const line = (text, i) => {
    if (text.startsWith(">"))
      return (
        <span key={i} className="dm-ln">
          <span className="dm-chev">&gt;</span>
          <span className="dm-you">{text.slice(1)}</span>
        </span>
      );
    if (text.startsWith("⏺")) {
      const [call, ...rest] = text.slice(2).split(" ");
      return (
        <span key={i} className="dm-ln">
          <span className="dm-tool">⏺ {call}</span>
          <span className="dm-dim">{rest.length ? ` ${rest.join(" ")}` : ""}</span>
        </span>
      );
    }
    if (text.trimStart().startsWith("⎿"))
      return (
        <span key={i} className="dm-ln">
          <span className="dm-dim">{"  ⎿"}</span>
          {text.trimStart().slice(1)}
        </span>
      );
    return (
      <span key={i} className="dm-ln">
        {text}
      </span>
    );
  };
  return (
    <div className="dm-term not-prose" role="figure" aria-label={title ? `Terminal: ${title}` : "Terminal"}>
      <div className="dm-term-bar">
        <span className="dm-lights" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="dm-term-title">{title}</span>
      </div>
      <pre className="dm-term-log">{lines.map(line)}</pre>
    </div>
  );
};
