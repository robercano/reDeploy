import { BENEFITS } from "../content.js";

export default function Benefits() {
  return (
    <section className="benefits" aria-labelledby="benefits-heading">
      <h2 id="benefits-heading">Why teams use reDeploy</h2>
      <p className="section-lede">
        For smart-contract teams deploying multi-contract systems across chains who need reproducible,
        resumable, verifiable deployments — and a visual way to wire and inspect them.
      </p>
      <ul className="benefits__list">
        {BENEFITS.map((benefit) => (
          <li key={benefit.id} className="benefits__item">
            <h3>{benefit.title}</h3>
            <p>{benefit.description}</p>
            <code className="benefits__package">{benefit.packageName}</code>
          </li>
        ))}
      </ul>
    </section>
  );
}
