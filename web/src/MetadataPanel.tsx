import type { Attribute, Metadata, Variable } from "./model";

export function MetadataPanel({ metadata, variable }: { metadata: Metadata; variable: Variable }) {
  return (
    <div className="metadata-panel">
      <section>
        <h2>{variable.path}</h2>
        <dl className="metadata-summary">
          <div><dt>stored type</dt><dd>{variable.dtype}</dd></div>
          <div>
            <dt>shape</dt>
            <dd>{variable.dimensions.map((dimension) => `${dimension.name}=${dimension.length}`).join(" × ") || "scalar"}</dd>
          </div>
          <div><dt>view hint</dt><dd>{variable.view_hint.kind}</dd></div>
        </dl>
      </section>
      <section>
        <h3>Dimensions</h3>
        <table>
          <thead><tr><th>Name</th><th>Length</th><th>Scope</th></tr></thead>
          <tbody>
            {variable.dimensions.map((dimension) => {
              const discovered = metadata.dimensions.find((candidate) => candidate.path === dimension.path);
              return (
                <tr key={dimension.path}>
                  <th>{dimension.name}</th>
                  <td>{dimension.length.toLocaleString()}</td>
                  <td>{dimension.path}{discovered?.unlimited ? " · unlimited" : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      <section>
        <h3>Attributes</h3>
        {variable.attributes.length ? (
          <table>
            <thead><tr><th>Name</th><th>Type</th><th>Value</th></tr></thead>
            <tbody>{variable.attributes.map((attribute) => <AttributeRow key={attribute.name} attribute={attribute} />)}</tbody>
          </table>
        ) : <p className="empty-note">No variable attributes.</p>}
      </section>
    </div>
  );
}

function AttributeRow({ attribute }: { attribute: Attribute }) {
  const value = Array.isArray(attribute.value)
    ? attribute.value.map(formatAttributeValue).join(", ")
    : formatAttributeValue(attribute.value);
  return (
    <tr>
      <th>{attribute.name}</th>
      <td>{attribute.dtype}</td>
      <td className="attribute-value">{value}{attribute.truncated ? " …" : ""}</td>
    </tr>
  );
}

function formatAttributeValue(value: number | string): string {
  return typeof value === "string" ? value : String(value);
}

