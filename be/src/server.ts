import { buildApp } from "./http/app.js";
import { buildServices } from "./composition.js";

const port = Number(process.env.PORT ?? 3000);
const services = buildServices();
const app = buildApp(services);

app.listen(port, () => {
  console.log(`Checkout & Rewards service listening on http://localhost:${port}`);
});
