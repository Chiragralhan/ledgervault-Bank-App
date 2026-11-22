// The "what's happening here" box shown on every page. This is the part you
// point at when explaining the project: each page says which backend idea
// it is demonstrating.
export default function Explain({ title = "What's happening here", children }) {
  return (
    <aside className="explain">
      <div className="explain-title">💡 {title}</div>
      <div className="explain-body">{children}</div>
    </aside>
  );
}